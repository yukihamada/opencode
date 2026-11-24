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
  warn: (message: string) => void
  signals?: Signals
  renewMs?: number
}

/** Leasing failed (twice); the caller stops the run rather than leave background commands unawaited. */
export class LeaseError extends Error {}

export async function holdOneShot(input: HoldInput) {
  const signals = input.signals ?? process
  // Change only our key, on a fresh read right before the write: the server replaces metadata
  // wholesale and has no partial update, so this keeps the window for clobbering others minimal.
  // The lease expiry is put on the server's clock (from its Date header), since the server judges it.
  const write = async (lease: boolean) => {
    const sent = Date.now()
    const current = await input.client.session.get({ sessionID: input.sessionID })
    if (!current.data) throw new Error("session not found")
    const metadata: Record<string, unknown> = { ...current.data.metadata }
    if (lease) metadata[ShellBackground.ONE_SHOT] = ShellBackground.lease(serverNow(current.response, sent))
    else delete metadata[ShellBackground.ONE_SHOT]
    const updated = await input.client.session.update({ sessionID: input.sessionID, metadata })
    if (updated.error) throw new Error(String(updated.error))
  }
  // Every write goes through one chain, so a renewal still in flight cannot land after the removal.
  let chain = Promise.resolve()
  const queue = (lease: boolean) => {
    const next = chain.then(() => write(lease))
    chain = next.catch(() => undefined)
    return next
  }

  // Jobs already in a joined session before this run are not ours (no clocks involved).
  const before = new Set(input.owned ? [] : (await jobs(input.client, input.sessionID)).started)
  // One retry, then give up: without the lease the server would tell the model a notification will
  // come, and this run would end (stopping the command) before it does.
  await queue(true)
    .catch(() => queue(true))
    .catch((error: unknown) => {
      throw new LeaseError(
        `could not mark the session as a one-shot run (${error instanceof Error ? error.message : String(error)})`,
      )
    })
  const timer = setInterval(() => void queue(true).catch(() => undefined), input.renewMs ?? ShellBackground.RENEW_MS)
  timer.unref?.()

  // Ctrl-C / kill: drop the lease before going, then let the signal take its normal course.
  let released: Promise<void> | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    void release().finally(() => {
      signals.off(signal, onSignal)
      signals.kill(signals.pid, signal)
    })
  }
  signals.on("SIGINT", onSignal)
  signals.on("SIGTERM", onSignal)

  function release() {
    released ??= (async () => {
      clearInterval(timer)
      signals.off("SIGINT", onSignal)
      signals.off("SIGTERM", onSignal)
      await queue(false).catch(() => undefined)
      const seen = await jobs(input.client, input.sessionID)
      const running = seen.started.filter((id) => !before.has(id) && !seen.finished.includes(id))
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

/** The server's current time, from the Date header of a response to a request sent at `sent`. */
function serverNow(response: Response | undefined, sent: number) {
  const date = Date.parse(response?.headers.get("date") ?? "")
  if (Number.isNaN(date)) return Date.now()
  // The header is the server time when it answered; add what has passed since (and its 1s rounding).
  return date + Math.max(0, Date.now() - sent)
}

/** Background shell jobs of the session, and those whose result was delivered. */
async function jobs(client: Client, sessionID: string) {
  const response = await client.session.messages({ sessionID }).catch(() => undefined)
  const parts = (response?.data ?? []).flatMap((message) => message.parts)
  const started: string[] = []
  const finished: string[] = []
  for (const part of parts) {
    if (part.type === "text" && part.synthetic) {
      const match = /<background_shell job="([^"]+)"/.exec(part.text)
      if (match) finished.push(match[1])
    }
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const metadata = part.state.metadata as Record<string, unknown> | undefined
    if (part.tool === "bash" && metadata?.background === true && typeof metadata.jobId === "string")
      started.push(metadata.jobId)
    if (part.tool === "wait" && typeof metadata?.jobId === "string" && metadata.status !== "pending")
      finished.push(metadata.jobId)
  }
  return { started, finished }
}
