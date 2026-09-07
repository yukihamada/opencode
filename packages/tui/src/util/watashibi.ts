import type { useSDK } from "../context/sdk"

/**
 * 渡し火 (Watashibi, "fire handoff").
 *
 * Long sessions rot: the context window fills with stale tool output and the
 * model's attention thins out. Compaction (`/restart`) shortens the same
 * conversation in place; Watashibi instead lets the fire burn down and carries
 * only the embers (種火, a short structured handoff note) to a brand-new
 * session with an empty context window.
 *
 * Flow: `/watashibi` → the current session writes `.sente/watashibi/latest.md`
 * (+ a timestamped copy) using its tools → once it goes idle a fresh session is
 * created and told to read that note and continue. Nothing else from the old
 * conversation crosses over.
 */
export namespace Watashibi {
  export const DIR = ".sente/watashibi"
  export const LATEST = `${DIR}/latest.md`

  /** Sections every ember note must have, in this order. */
  export const SECTIONS = ["目的 / Goal", "済み / Done (evidence)", "いまの状態 / State", "次の一手 / Next", "罠 / Gotchas", "触るファイル / Files", "未確認 / Unverified"]

  /** Sent to the *old* session: write the ember note, then stop. */
  export function writePrompt(now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19)
    return [
      "渡し火 (Watashibi): this conversation is about to be handed off to a fresh session with an empty context window.",
      `Write the handoff note ("種火", embers) to \`${LATEST}\` and also copy it to \`${DIR}/${stamp}.md\` (create the directory if needed).`,
      "It is the ONLY thing the next session will see, so make it self-contained and short (aim for under 60 lines). Use exactly these sections, in this order:",
      ...SECTIONS.map((s, i) => `${i + 1}. ## ${s}`),
      "Rules: state facts you verified (with file paths, commands, PR numbers); mark anything you did not verify under 未確認; write the concrete next step first, not a plan; no chat history, no apologies.",
      "After writing the file, reply with one line: `渡し火 ready` — do nothing else.",
    ].join("\n")
  }

  /** Sent to the *new* session as its first turn. */
  export const RESUME_PROMPT = [
    `渡し火 (Watashibi): you are a fresh session. The previous session left its handoff note at \`${LATEST}\`.`,
    "1. Read that file first. Treat it as the whole context; do not try to recover the old conversation.",
    "2. Re-check the current state of the files and tools it names before acting; do not assume earlier edits landed.",
    "3. Continue from the 次の一手 / Next section until the goal is done, then report what you did and what is left.",
    "If the note is missing or unclear, say so in one line and ask.",
  ].join("\n")

  export type SendInput = {
    sessionID: string
    model: { providerID: string; modelID: string }
    agent?: string
    variant?: string
  }

  function send(sdk: ReturnType<typeof useSDK>, input: SendInput, text: string) {
    return sdk.client.session.prompt(
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
        parts: [{ type: "text", text }],
      },
      { throwOnError: true },
    )
  }

  /** Ask the current session to write the ember note. */
  export function requestNote(sdk: ReturnType<typeof useSDK>, input: SendInput) {
    return send(sdk, input, writePrompt())
  }

  /** Create the fresh session and hand it the ember note. Returns the new session id. */
  export async function ignite(
    sdk: ReturnType<typeof useSDK>,
    input: Omit<SendInput, "sessionID"> & { directory?: string; workspace?: string },
  ) {
    const created = await sdk.client.session.create(
      {
        directory: input.directory,
        workspace: input.workspace,
        agent: input.agent,
        model: { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant },
      },
      { throwOnError: true },
    )
    const sessionID = created.data.id
    await send(sdk, { ...input, sessionID }, RESUME_PROMPT)
    return sessionID
  }
}
