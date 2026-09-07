import { describe, expect, test } from "bun:test"
import { Watashibi } from "../../src/util/watashibi"

describe("Watashibi (渡し火)", () => {
  test("write prompt names the ember note path and every section in order", () => {
    const prompt = Watashibi.writePrompt(new Date("2026-09-07T12:34:56Z"))
    expect(prompt).toContain(Watashibi.LATEST)
    expect(prompt).toContain(`${Watashibi.DIR}/2026-09-07T12-34-56.md`)
    let last = -1
    for (const section of Watashibi.SECTIONS) {
      const at = prompt.indexOf(`## ${section}`)
      expect(at).toBeGreaterThan(last)
      last = at
    }
    // The old session must stop after writing — nothing else may cross over.
    expect(prompt).toContain("渡し火 ready")
  })

  test("resume prompt points the fresh session at the note only", () => {
    expect(Watashibi.RESUME_PROMPT).toContain(Watashibi.LATEST)
    expect(Watashibi.RESUME_PROMPT).toContain("do not try to recover the old conversation")
    expect(Watashibi.RESUME_PROMPT).toContain("次の一手")
  })

  test("ignite creates a session in the old directory and sends the resume prompt", async () => {
    const calls: Record<string, unknown>[] = []
    const sdk = {
      client: {
        session: {
          create: async (body: Record<string, unknown>) => {
            calls.push({ create: body })
            return { data: { id: "ses_new" } }
          },
          prompt: async (body: Record<string, unknown>) => {
            calls.push({ prompt: body })
            return { data: {} }
          },
        },
      },
    }
    const id = await Watashibi.ignite(sdk as never, {
      model: { providerID: "teai", modelID: "kimi-k3" },
      agent: "build",
      directory: "/tmp/proj",
      workspace: "ws_1",
    })
    expect(id).toBe("ses_new")
    expect(calls[0]?.create).toMatchObject({ directory: "/tmp/proj", workspace: "ws_1", agent: "build", model: { providerID: "teai", id: "kimi-k3" } })
    const prompt = calls[1]?.prompt as { sessionID: string; parts: { text: string }[] }
    expect(prompt.sessionID).toBe("ses_new")
    expect(prompt.parts[0]?.text).toBe(Watashibi.RESUME_PROMPT)
  })
})
