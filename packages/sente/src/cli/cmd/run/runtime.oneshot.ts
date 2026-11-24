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
  startedAt?: number
  signals?: Signals
  renewMs?: number
}

export async function holdOneShot(input: HoldInput) {
  const startedAt = input.startedAt ?? Date.now()
  const signals = input.signals ?? process
  // Change only our key, on a fresh read right before the write: the server replaces metadata
  // wholesale and has no partial update, so this keeps the window for clobbering others minimal.
  const write = async (value: ShellBackground.Lease | undefined) => {
    const current = await input.client.session.get({ sessionID: input.sessionID })
    if (!current.data) throw new Error("session not found")
    const metadata: Record<string, unknown> = { ...current.data.metadata }
    if (value) metadata[ShellBackground.ONE_SHOT] = value
    else delete metadata[ShellBackground.ONE_SHOT]
    const updated = await input.client.session.update({ sessionID: input.sessionID, metadata })
    if (updated.error) throw new Error(String(updated.error))
  }

  const marked = await write(ShellBackground.lease()).then(
    () => true,
    (error: unknown) => {
      input.warn(
        `could not mark the session as a one-shot run (${error instanceof Error ? error.message : String(error)}); a shell command that outlives its timeout may not be waited for`,
      )
      return false
    },
  )
  const timer = marked
    ? setInterval(
        () => void write(ShellBackground.lease()).catch(() => undefined),
        input.renewMs ?? ShellBackground.RENEW_MS,
      )
    : undefined
  timer?.unref?.()

  // Ctrl-C / kill: drop the lease before going, then let the signal take its normal course.
  let released: Promise<void> | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    void release().finally(() => {
      signals.off(signal, onSignal)
      signals.kill(signals.pid, signal)
    })
  }
  if (marked) {
    signals.on("SIGINT", onSignal)
    signals.on("SIGTERM", onSignal)
  }

  function release() {
    released ??= (async () => {
      if (timer) clearInterval(timer)
      signals.off("SIGINT", onSignal)
      signals.off("SIGTERM", onSignal)
      if (marked) await write(undefined).catch(() => undefined)
      const running = await leftover(input.client, input.sessionID, startedAt)
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

  return { marked, release }
}

/** Background shell jobs this run started whose result it never saw. */
async function leftover(client: Client, sessionID: string, since: number) {
  const response = await client.session.messages({ sessionID }).catch(() => undefined)
  const parts = (response?.data ?? []).flatMap((message) => message.parts)
  const started = new Set<string>()
  const finished = new Set<string>()
  for (const part of parts) {
    if (part.type === "text" && part.synthetic) {
      const match = /<background_shell job="([^"]+)"/.exec(part.text)
      if (match) finished.add(match[1])
    }
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const metadata = part.state.metadata as Record<string, unknown> | undefined
    if (part.tool === "bash" && metadata?.background === true && typeof metadata.jobId === "string") {
      if (part.state.time.start >= since) started.add(metadata.jobId)
    }
    if (part.tool === "wait" && typeof metadata?.jobId === "string" && metadata.status !== "pending")
      finished.add(metadata.jobId)
  }
  return [...started].filter((id) => !finished.has(id))
}
