import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@sente-ai/sdk/v2"
import { toolInlineInfo, toolScroll, toolFrame } from "../../../src/cli/cmd/run/tool"

const part = (metadata: Record<string, unknown>) =>
  ({
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "sleep 600" },
      output: "moved",
      title: "sleep 600",
      metadata,
      time: { start: 1, end: 2 },
    },
  }) as unknown as ToolPart

describe("sente run: bash that moved to the background", () => {
  test("is shown as running in the background with its job, not as completed", () => {
    const moved = part({ output: "", exit: null, truncated: false, background: true, jobId: "job_abc" })
    expect(toolInlineInfo(moved).title).toContain("running in background (job job_abc)")
    const final = toolScroll(
      "final",
      toolFrame({ kind: "tool", phase: "final", tool: "bash", part: moved } as never, ""),
    )
    expect(final).toContain("bash running in background (job job_abc)")
    expect(final).not.toContain("completed")
  })

  test("an ordinary command still reads as completed", () => {
    const done = part({ output: "ok", exit: 0, truncated: false })
    expect(toolInlineInfo(done).title).toBe("sleep 600")
    const final = toolScroll(
      "final",
      toolFrame({ kind: "tool", phase: "final", tool: "bash", part: done } as never, ""),
    )
    expect(final).toContain("bash completed (exit 0)")
  })
})
