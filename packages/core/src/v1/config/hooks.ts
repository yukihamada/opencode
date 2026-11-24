export * as ConfigHooksV1 from "./hooks"

import { Schema } from "effect"

export const Command = Schema.Struct({
  type: Schema.String.annotate({
    description: 'Hook type. Only "command" is supported; entries of any other type are skipped.',
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "Shell command to run. It receives the event as JSON on stdin and controls Sente with its exit code (2 blocks) or a JSON object on stdout.",
  }),
  timeout: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
    description:
      "Seconds before the command is killed (default: 60). A PreToolUse or UserPromptSubmit hook that times out blocks (fail closed); other events continue.",
  }),
})
export type Command = Schema.Schema.Type<typeof Command>

export const Matcher = Schema.Struct({
  matcher: Schema.optional(Schema.String).annotate({
    description:
      'Which events this group handles. PreToolUse/PostToolUse: tool name, e.g. "bash|edit" or a regular expression ("" or "*" matches every tool). SessionStart: source. Notification: notification type. Ignored for other events.',
  }),
  hooks: Schema.mutable(Schema.Array(Command)),
})
export type Matcher = Schema.Schema.Type<typeof Matcher>

export const Info = Schema.Record(Schema.String, Schema.mutable(Schema.Array(Matcher))).annotate({
  description:
    "Shell commands run on events, in the Claude Code hooks format. Supported events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, Notification. Hooks from a project's own config or a remote organization config run only after `sente hooks trust`.",
})
export type Info = Schema.Schema.Type<typeof Info>
