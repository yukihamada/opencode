import type { SessionV1 } from "@sente-ai/core/v1/session"

// The session title is anchored to the first request (the goal). Later messages may refine it,
// but must not replace it: previously every new message re-titled the session after itself.

const FIRST_LIMIT = 1200
const LATER_LIMIT = 300
const LATER_COUNT = 6

export function messageText(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" && !part.synthetic) return [part.text]
      if (part.type === "subtask") return [part.prompt]
      return []
    })
    .join("\n")
    .trim()
}

function clip(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) + "…" : text
}

export function request(input: { first: string; later: string[]; current?: string }) {
  const later = input.later.filter((text) => text.length > 0).slice(-LATER_COUNT)
  const rules = [
    "Generate a short title for this session. The title states the session's GOAL, which is set by the FIRST request.",
    "Later messages are follow-ups (corrections, details, small asks). Use them only to refine the goal's wording; never title the session after a later message, and never copy a message as the title.",
    ...(input.current
      ? [
          "A current title already exists. Keep its core words in the new title so it stays clearly the same goal — refine, do not replace. If the goal is unchanged, output the current title unchanged.",
        ]
      : []),
    "Use the same language as the first request.",
  ]
  const blocks = [
    `<first_request>\n${clip(input.first, FIRST_LIMIT)}\n</first_request>`,
    ...(later.length ? [`<later_messages>\n${later.map((text) => `- ${clip(text, LATER_LIMIT)}`).join("\n")}\n</later_messages>`] : []),
    ...(input.current ? [`<current_title>${input.current}</current_title>`] : []),
  ]
  return [...rules, "", ...blocks].join("\n")
}

const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")

// Small title models still tend to echo the newest message. Keep the current title when the
// candidate is just a slice of the latest follow-up and not of the original goal.
export function echoesLatest(input: { candidate: string; first: string; latest: string }) {
  const candidate = normalize(input.candidate)
  if (candidate.length < 4) return false
  return normalize(input.latest).includes(candidate) && !normalize(input.first).includes(candidate)
}

// A refined title must keep the previous title's wording so the session is still recognizable
// by its earlier name. When the candidate drops most of the current title, keep the current one.
export function retainsCurrent(input: { candidate: string; current: string }) {
  const candidate = normalize(input.candidate)
  const current = normalize(input.current)
  if (!current) return true
  if (!candidate) return false
  if (candidate.includes(current) || current.includes(candidate)) return true
  const chars = new Set(current)
  let shared = 0
  for (const char of chars) if (candidate.includes(char)) shared++
  return shared / chars.size >= 0.5
}

export * as SessionTitle from "./title"
