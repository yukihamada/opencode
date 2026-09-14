import { describe, expect, test } from "bun:test"
import { createSenteClient } from "@sente-ai/sdk/v2"
import { promptUnchanged, sendFailureText, sendPrompt } from "../../../src/prompt/send"
import type { PromptInfo } from "../../../src/prompt/history"

const attachment = {
  type: "file" as const,
  mime: "image/png",
  url: "data:image/png;base64,aA==",
  filename: "image.png",
}

function submission(mode: "normal" | "shell" = "normal", text = "Review this") {
  return {
    sessionID: "ses_test",
    prompt: { input: text, mode, parts: [attachment] },
    text,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    variant: "high",
    commands: ["review"],
    editorParts: [{ type: "text" as const, text: "selected code", synthetic: true }],
  }
}

describe("prompt delivery through the real SDK", () => {
  for (const input of [
    submission(),
    submission("shell", "pwd"),
    submission("normal", "/review details\nsecond line\n"),
  ]) {
    const endpoint = input.prompt.mode === "shell" ? "shell" : input.text.startsWith("/") ? "command" : "message"

    test(`${endpoint}: surfaces HTTP failures for draft recovery`, async () => {
      const requests: string[] = []
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          requests.push(new URL(request.url).pathname)
          return Response.json({ name: "UnknownError", data: { message: "server unavailable" } }, { status: 503 })
        },
      })
      const client = createSenteClient({ baseUrl: server.url.toString() })
      await expect(sendPrompt(client, input)).rejects.toBeDefined()
      expect(requests).toEqual([`/session/ses_test/${endpoint}`])
      expect(input.prompt.parts).toEqual([attachment])
    })

    test(`${endpoint}: preserves the submitted payload`, async () => {
      const bodies: Record<string, unknown>[] = []
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          bodies.push(await request.json())
          return Response.json({})
        },
      })
      const client = createSenteClient({ baseUrl: server.url.toString() })
      const result = await sendPrompt(client, input)
      expect(bodies).toHaveLength(1)
      expect(bodies[0].agent).toBe("build")
      expect(result.editorSent).toBe(endpoint === "message")
      if (endpoint === "shell") {
        expect(bodies[0].command).toBe("pwd")
        expect(bodies[0].model).toEqual(input.model)
        return
      }
      if (endpoint === "command") {
        expect(bodies[0].command).toBe("review")
        expect(bodies[0].arguments).toBe("details\nsecond line\n")
        expect(bodies[0].model).toBe("test/test-model")
        expect(bodies[0].parts).toEqual([attachment])
        return
      }
      expect(bodies[0].parts).toEqual([...input.editorParts, { type: "text", text: input.text }, attachment])
      expect(bodies[0].variant).toBe("high")
    })
  }

  test("connection failure is observable without automatic resubmission", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) })
    const client = createSenteClient({ baseUrl: server.url.toString() })
    await server.stop(true)
    await expect(sendPrompt(client, submission())).rejects.toBeDefined()
  })

  test("unknown slash text remains a normal prompt and expands pasted text only once", async () => {
    const bodies: Record<string, unknown>[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/session/ses_test/message")
        bodies.push(await request.json())
        return Response.json({})
      },
    })
    const input = submission("normal", "/unknown expanded paste")
    await sendPrompt(createSenteClient({ baseUrl: server.url.toString() }), {
      ...input,
      prompt: { ...input.prompt, parts: [...input.prompt.parts, { type: "text", text: "expanded paste" }] },
    })
    expect(bodies[0].parts).toEqual([...input.editorParts, { type: "text", text: input.text }, attachment])
  })
})

describe("draft ownership while session creation is pending", () => {
  const sent: PromptInfo = { input: "First request", parts: [attachment], mode: "normal" }

  test("only the unchanged draft may be cleared", () => {
    expect(promptUnchanged(sent, structuredClone(sent))).toBe(true)
    expect(promptUnchanged(sent, { ...sent, input: "First request with an unsent addition" })).toBe(false)
    expect(promptUnchanged(sent, { ...sent, input: "" })).toBe(false)
    expect(promptUnchanged(sent, { ...sent, mode: "shell" })).toBe(false)
    expect(promptUnchanged(sent, { ...sent, parts: [] })).toBe(false)
    expect(promptUnchanged(sent, { ...sent, parts: [{ ...attachment, url: "data:image/png;base64,bg==" }] })).toBe(
      false,
    )
  })

  test("old drafts without a mode still represent normal input", () => {
    expect(promptUnchanged(sent, { input: sent.input, parts: sent.parts })).toBe(true)
  })
})

test("recovery guidance is available in Japanese and English", () => {
  expect(sendFailureText("ja-JP").saved).toContain("Stash list")
  expect(sendFailureText("ja-JP").saved).toContain("入力を戻す")
  expect(sendFailureText("ja-JP").retained).toContain("入力は残っています")
  expect(sendFailureText("en-US").saved).toContain("Check the conversation")
  expect(sendFailureText("fr-FR").recover).toEqual(sendFailureText("en-US").recover)
})
