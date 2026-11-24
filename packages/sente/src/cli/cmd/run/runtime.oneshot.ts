// `sente run --attach` drives a session on a server that outlives this process. While it runs, the
// session carries a lease (ShellBackground.ONE_SHOT) so a shell command that outlives its timeout
// tells the model to wait for it in-turn; a local run is recognised by SENTE_NONINTERACTIVE instead.
import type { SenteClient } from "@sente-ai/sdk/v2"
import { ShellBackground } from "@/tool/shell/background"

type Client = {
  session: Pick<SenteClient["session"], "get" | "update" | "abort" | "messages">
}

type Signals = Pick<NodeJS.Process, "on" | "off" | "kill" | "pid">

export type HoldInput = {
  client: Client
  sessionID: string
  /** This run created (or forked) the session, so nobody else's work lives in it. */
  owned: boolean
  /** The user message ID this run sends its prompt with: its turn, as far as the server can tell. */
  message: string
  /** false when SENTE_SHELL_TIMEOUT_BACKGROUND=0 here: no lease, only the cleanup at the end. */
  lease?: boolean
  warn: (message: string) => void
  signals?: Signals
  renewMs?: number
  /** Pause before re-reading a write (tests). */
  settleMs?: number
}

/** Leasing failed (twice); the caller stops the run rather than leave background commands unawaited. */
export class LeaseError extends Error {}

/**
 * SENTE_SHELL_TIMEOUT_BACKGROUND=0 on the client: the user opted out, so run without a lease (the
 * escape hatch when leasing fails). Set on the server too, timed-out commands are then stopped.
 */
export function leaseDisabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SENTE_SHELL_TIMEOUT_BACKGROUND?.trim().toLowerCase()
  return value === "0" || value === "false" || value === "no" || value === "off"
}

// Server clocks this far from ours are reported, though still used (the server judges the lease).
const SKEW_WARN_MS = 12 * 60 * 60 * 1000

export async function holdOneShot(input: HoldInput) {
  const signals = input.signals ?? process
  const id = crypto.randomUUID()
  const leasing = input.lease !== false
  let clockNoted = false
  const note = (message: string) => {
    if (clockNoted) return
    clockNoted = true
    input.warn(message)
  }
  // Change only our key, on a fresh read right before the write: the server replaces metadata
  // wholesale and has no partial update, so this keeps the window for clobbering others minimal.
  // The lease expiry is put on the server's clock, since the server judges it.
  const write = async (lease: boolean) => {
    const sent = Date.now()
    const current = await input.client.session.get(
      { sessionID: input.sessionID },
      { headers: { "cache-control": "no-store" } },
    )
    if (!current.data) throw new Error("session not found")
    // Only this run's entry in the map: concurrent runs on the same session keep theirs.
    const metadata: Record<string, unknown> = { ...current.data.metadata }
    const map = { ...ShellBackground.leases(current.data) }
    if (lease) map[id] = ShellBackground.lease(input.message, serverNow(current.response, sent, note))
    else delete map[id]
    if (Object.keys(map).length > 0) metadata[ShellBackground.ONE_SHOT] = map
    else delete metadata[ShellBackground.ONE_SHOT]
    const updated = await input.client.session.update({ sessionID: input.sessionID, metadata })
    if (updated.error) throw new Error(String(updated.error))
  }
  // Another run on the same session may write its own entry from a read taken just before ours and so
  // undo our change (no atomic update on the server). Re-read after a short random pause and redo it
  // until it holds; both sides doing this converges.
  const settle = async (lease: boolean) => {
    for (let attempt = 0; ; attempt++) {
      await write(lease)
      await Bun.sleep(input.settleMs ?? 100 + Math.floor(Math.random() * 200))
      const current = await input.client.session.get(
        { sessionID: input.sessionID },
        { headers: { "cache-control": "no-store" } },
      )
      const held = id in ShellBackground.leases(current.data ?? undefined)
      if (held === lease || attempt >= 4) return
    }
  }
  // Every write goes through one chain, so a renewal still in flight cannot land after the removal.
  let chain = Promise.resolve()
  const queue = (lease: boolean) => {
    const next = chain.then(() => settle(lease))
    chain = next.catch(() => undefined)
    return next
  }

  // One retry, then give up: without the lease the server would tell the model a notification will
  // come, and this run would end (stopping the command) before it does.
  if (leasing)
    await queue(true)
      .catch(() => queue(true))
      .catch((error: unknown) => {
        throw new LeaseError(
          `could not mark the session as a one-shot run (${error instanceof Error ? error.message : String(error)})`,
        )
      })
  else
    input.warn(
      "running without the one-shot lease (SENTE_SHELL_TIMEOUT_BACKGROUND=0 here); if the server moves a timed-out command to the background, the model may not wait for it. Commands this run leaves behind are cleaned up at the end",
    )
  // A renewal failing now and then is harmless (the lease lasts three renewals); two in a row is not.
  let failures = 0
  const timer = leasing ? setInterval(renew, input.renewMs ?? ShellBackground.RENEW_MS) : undefined
  timer?.unref?.()
  function renew() {
    void queue(true).then(
      () => {
        failures = 0
      },
      (error: unknown) => {
        failures++
        if (failures === 2)
          input.warn(
            `could not renew the one-shot lease twice in a row (${error instanceof Error ? error.message : String(error)}); if it lapses, a command that outlives its timeout may not be waited for`,
          )
      },
    )
  }

  // Ctrl-C / kill: drop the lease before going, then let the signal take its normal course.
  let released: Promise<void> | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    void release().finally(() => {
      signals.off(signal, onSignal)
      signals.kill(signals.pid, signal)
    })
  }
  if (leasing) {
    signals.on("SIGINT", onSignal)
    signals.on("SIGTERM", onSignal)
  }

  function release() {
    released ??= (async () => {
      clearInterval(timer)
      signals.off("SIGINT", onSignal)
      signals.off("SIGTERM", onSignal)
      if (leasing) await queue(false).catch(() => undefined)
      // In a session this run made every job is its own; in a joined one, only those of its own turn.
      const seen = await jobs(input.client, input.sessionID, input.owned ? undefined : input.message).catch(
        (error: unknown) => {
          input.warn(
            `could not check for background commands left by this run (${error instanceof Error ? error.message : String(error)})`,
          )
          return undefined
        },
      )
      // Unknown: in a session this run made, stopping is the safe side; elsewhere it is not ours to stop.
      if (!seen) {
        if (input.owned) await input.client.session.abort({ sessionID: input.sessionID }).catch(() => undefined)
        return
      }
      const running = seen.started.filter((job) => !seen.finished.includes(job))
      if (running.length === 0) return
      // Only a session this run made is ours to interrupt; in someone else's session it would also stop
      // their turn, subagents and jobs. There the commands end on their own or at the lifetime limit.
      if (input.owned) {
        await input.client.session.abort({ sessionID: input.sessionID }).catch(() => undefined)
        return
      }
      input.warn(
        `${running.length} background command(s) started by this run may still be running on the server (${running.join(", ")}); they end on their own, at the background time limit, or when the session is interrupted`,
      )
    })()
    return released
  }

  return { release }
}

/** The server's current time, from the Date (and Age) headers of a response to a request sent at `sent`. */
function serverNow(response: Response | undefined, sent: number, warn: (message: string) => void) {
  const date = Date.parse(response?.headers.get("date") ?? "")
  if (Number.isNaN(date)) {
    warn("the server sent no Date header; the one-shot lease expiry uses this machine's clock")
    return Date.now()
  }
  // A cached answer is older than its Date by Age seconds.
  const age = Number(response?.headers.get("age") ?? 0)
  // The header is the server time when it answered (1s resolution); add what has passed since.
  const now = date + (Number.isFinite(age) && age > 0 ? age * 1000 : 0) + Math.max(0, Date.now() - sent)
  if (Math.abs(now - Date.now()) > SKEW_WARN_MS)
    warn(
      `the server clock differs from this machine by about ${Math.round(Math.abs(now - Date.now()) / 3_600_000)} h; the one-shot lease follows the server clock`,
    )
  return now
}

/** Background shell jobs of the session (only those of the turn answering `turn`, if given), and delivered ones. */
async function jobs(client: Client, sessionID: string, turn?: string) {
  const response = await client.session.messages({ sessionID })
  if (!response.data) throw new Error(response.error ? String(response.error) : "no messages returned")
  const started: string[] = []
  const finished: string[] = []
  for (const message of response.data) {
    const ours = turn === undefined || (message.info as { parentID?: string }).parentID === turn
    for (const part of message.parts) {
      if (part.type === "text" && part.synthetic) {
        const match = /<background_shell job="([^"]+)"/.exec(part.text)
        if (match) finished.push(match[1])
      }
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const metadata = part.state.metadata as Record<string, unknown> | undefined
      if (ours && part.tool === "bash" && metadata?.background === true && typeof metadata.jobId === "string")
        started.push(metadata.jobId)
      if (part.tool === "wait" && typeof metadata?.jobId === "string" && metadata.status !== "pending")
        finished.push(metadata.jobId)
    }
  }
  return { started, finished }
}
