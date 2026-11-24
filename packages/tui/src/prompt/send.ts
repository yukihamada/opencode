import type { SenteClient, TextPartInput } from "@sente-ai/sdk/v2"
import type { PromptInfo } from "./history"
import type { StashEntry } from "./stash"

export async function deliverPrompt(
  client: SenteClient,
  input: Parameters<typeof sendPrompt>[1],
  stash: { push: (entry: Omit<StashEntry, "timestamp">) => void },
) {
  return sendPrompt(client, input).then(
    (result) => ({ sent: true as const, ...result }),
    (error: unknown) => {
      // A UserPromptSubmit hook refused the prompt on purpose: nothing was lost in transit, so it is not a recovery
      // case for the stash. The prompt stays in history.
      const blocked = hookBlockReason(error)
      if (blocked !== undefined) return { sent: false as const, error, blocked }
      stash.push({ ...input.prompt, recovery: { id: crypto.randomUUID(), sessionID: input.sessionID } })
      return { sent: false as const, error, blocked }
    },
  )
}

// The server answers a prompt refused by a UserPromptSubmit hook with a HookBlockedError body. The SDK throws an Error
// carrying that body in `cause.body`; accept the bare body too.
export function hookBlockReason(error: unknown) {
  const body = errorBody(error)
  if (!body || body.name !== "HookBlockedError") return
  const data = body.data && typeof body.data === "object" ? body.data : {}
  const message = "message" in data && typeof data.message === "string" ? data.message : ""
  return message.replace(/^UserPromptSubmit hook blocked this prompt: /, "")
}

function errorBody(error: unknown): { name?: unknown; data?: unknown } | undefined {
  if (!error || typeof error !== "object") return
  if ("name" in error && error.name === "HookBlockedError") return error
  const cause = "cause" in error ? error.cause : undefined
  if (!cause || typeof cause !== "object" || !("body" in cause)) return
  const body = cause.body
  return body && typeof body === "object" ? body : undefined
}

export function hookBlockedText(reason: string, locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  if (locale.toLowerCase().startsWith("ja"))
    return { title: "フックにより送信を止めました", message: `${reason}\n入力は履歴に残っています。` }
  return { title: "A hook stopped this prompt", message: `${reason}\nYour input is kept in history.` }
}

export async function sendPrompt(
  client: SenteClient,
  input: {
    sessionID: string
    prompt: PromptInfo
    text: string
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    commands: string[]
    editorParts: TextPartInput[]
  },
) {
  const options = { throwOnError: true } as const
  const common = { sessionID: input.sessionID, agent: input.agent, model: input.model }
  if (input.prompt.mode === "shell") {
    await client.session.shell({ ...common, command: input.text }, options)
    return { editorSent: false }
  }

  const parts = input.prompt.parts.filter((part) => part.type !== "text")
  const firstLineEnd = input.text.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? input.text : input.text.slice(0, firstLineEnd)
  const [command, ...args] = firstLine.split(" ")
  if (command.startsWith("/") && input.commands.includes(command.slice(1))) {
    await client.session.command(
      {
        ...common,
        model: `${input.model.providerID}/${input.model.modelID}`,
        command: command.slice(1),
        arguments: args.join(" ") + (firstLineEnd === -1 ? "" : input.text.slice(firstLineEnd)),
        variant: input.variant,
        parts: parts.filter((part) => part.type === "file"),
      },
      options,
    )
    return { editorSent: false }
  }

  await client.session.prompt(
    {
      ...common,
      variant: input.variant,
      parts: [...input.editorParts, { type: "text", text: input.text }, ...parts],
    },
    options,
  )
  return { editorSent: input.editorParts.length > 0 }
}

export function promptUnchanged(sent: PromptInfo, current: PromptInfo) {
  return (
    sent.input === current.input &&
    (sent.mode ?? "normal") === (current.mode ?? "normal") &&
    JSON.stringify(sent.parts) === JSON.stringify(current.parts)
  )
}

export function sendFailureText(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  if (locale.toLowerCase().startsWith("ja")) {
    return {
      title: "送信を確認できませんでした",
      saved: "入力欄の「入力を戻す」で復元できます。「Stash list」からも取り出せます。",
      retained: "入力は残っています。接続を確認してください。",
      recover: "入力を戻す",
      review: "再送前に会話を確認してください。書きかけは退避されます。",
      pending: (count: number) => `送信未確認の入力 ${count}件`,
      volatile: "端末への保存に失敗しました。終了前に入力を戻してコピーしてください。",
    }
  }
  return {
    title: "Could not confirm submission",
    saved: 'Use "Restore input" above the input box, or open "Stash list". Check the conversation before resending.',
    retained: "Your input is still here. Check your connection.",
    recover: "Restore input",
    review: "Check the conversation before resending. Your current draft will be stashed.",
    pending: (count: number) => `${count} unconfirmed submission${count === 1 ? "" : "s"}`,
    volatile: "Could not save to disk. Restore and copy your input before quitting.",
  }
}
