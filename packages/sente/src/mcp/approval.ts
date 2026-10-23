import { createHash } from "node:crypto"

export function operationBound(permission: string) {
  return permission.startsWith("playwright_") || permission.startsWith("travel_")
}

// Snapshot after trusted before-hooks. Never execute a mutable reference retained
// by a hook while a human is reviewing a different set of arguments.
export function prepare(permission: string, input: Record<string, unknown>) {
  if (!operationBound(permission)) {
    return { args: input, request: { permission, metadata: {}, patterns: ["*"], always: ["*"] } }
  }
  const serialized = JSON.stringify(input ?? {})
  if (serialized.length > 16000) throw new Error("Operation approval payload exceeds 16000 characters")
  const args: Record<string, unknown> = JSON.parse(serialized)
  const preview = JSON.stringify(args, (key, value) => {
    if (/password|passwd|secret|token|authorization|cookie|api.?key/i.test(key)) return "[redacted]"
    if (typeof value !== "string") return value
    return value
      .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
      .replace(/([?&](?:token|api_key|key|secret|password|signature|access_token)=)[^&#\s]*/gi, "$1[redacted]")
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
  }, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (value) =>
    `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
  // Fail closed rather than approving an invisible, truncated payload.
  if (preview.length > 16000) throw new Error("Operation approval payload exceeds 16000 characters")
  return {
    args,
    request: {
      permission,
      metadata: {
        operation: preview,
        fingerprint: createHash("sha256").update(serialized).digest("hex"),
      },
      patterns: ["*"],
      always: [],
    },
  }
}

export * as McpApproval from "./approval"
