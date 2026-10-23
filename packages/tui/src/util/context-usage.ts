import type { AssistantMessage, Message, Part } from "@sente-ai/sdk/v2"
import { Token } from "@sente-ai/core/util/token"

/** Provider usage on a summary describes the discarded input, not the new context. */
export function contextUsage(messages: readonly Message[], parts: (id: string) => readonly Part[] | undefined) {
  const index = messages.findLastIndex(
    (item) => item.role === "assistant" && (item.summary ? item.finish && !item.error : total(item) > 0),
  )
  const last = messages[index]
  if (!last || last.role !== "assistant") return
  if (!last.summary) {
    return { tokens: total(last), estimated: false, providerID: last.providerID, modelID: last.modelID }
  }
  if (!parts(last.id)?.some((part) => part.type === "text" && part.text.length > 0)) return

  const parentIndex = messages.findIndex((item) => item.id === last.parentID)
  const parent = messages[parentIndex]
  const marker = parts(last.parentID)?.find((part) => part.type === "compaction")
  if (!parent || parent.role !== "user" || !marker) return
  const start = marker.tail_start_id ? messages.findIndex((item) => item.id === marker.tail_start_id) : parentIndex
  // Parts and retained messages can arrive after message.updated during sync.
  if (start < 0 || start > parentIndex) return
  const retained = [...messages.slice(start, parentIndex), ...messages.slice(index)]
  let tokens = Token.estimate("What did we do so far?")
  for (const message of retained) {
    const content = parts(message.id)
    if (!content) return
    for (const part of content) {
      if (part.type === "text" && !part.ignored) tokens += Token.estimate(part.text)
      if (part.type === "reasoning") tokens += Token.estimate(part.text)
      if (part.type === "tool") {
        tokens += Token.estimate(JSON.stringify(part.state.input))
        if (part.state.status === "completed") {
          tokens += Token.estimate(part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output)
        }
        if (part.state.status === "error") tokens += Token.estimate(part.state.error)
      }
    }
  }
  // This is a text estimate: system/tool definitions and media are only measured
  // by the next provider response. Keep it visibly approximate until then.
  return { tokens, estimated: true, providerID: parent.model.providerID, modelID: parent.model.modelID }
}

function total(message: AssistantMessage) {
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  )
}
