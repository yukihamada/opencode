export * as ConfigDataPolicyV1 from "./data-policy"

import { Schema } from "effect"

export const Mode = Schema.Literals(["off", "warn", "block"]).annotate({ identifier: "DataPolicyMode" })
export type Mode = Schema.Schema.Type<typeof Mode>

export const MaskPattern = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Regular expression matched against outbound prompt text" }),
  replacement: Schema.String.annotate({ description: "Replacement applied to every match" }),
}).annotate({ identifier: "DataPolicyMaskPattern" })
export type MaskPattern = Schema.Schema.Type<typeof MaskPattern>

export const Info = Schema.Struct({
  mode: Schema.optional(Mode).annotate({
    description: "How to react when a prompt matches denyPatterns: 'off' disables checks, 'warn' logs, 'block' aborts the request (default: off)",
  }),
  denyPatterns: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Regular expressions that must not appear in outbound prompt text",
  }),
  maskPatterns: Schema.optional(Schema.mutable(Schema.Array(MaskPattern))).annotate({
    description: "Regular expressions replaced in outbound prompt text before it is sent",
  }),
  denyPaths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Glob patterns for file paths whose contents must not be sent to the model",
  }),
}).annotate({ identifier: "DataPolicyConfig" })
export type Info = Schema.Schema.Type<typeof Info>
