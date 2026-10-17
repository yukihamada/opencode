#!/usr/bin/env bun
// Local OpenAI-compatible fixture server for output-limit TUI verification.
// Serves /v1/chat/completions with queued SSE replies. No real model is called.
//
// Usage: bun script/verify/output-limit-fixture.ts <stateDir>
// Writes <stateDir>/port once listening. Control via files:
//   <stateDir>/queue.json   — array of queued replies, consumed in order
//   <stateDir>/hits.jsonl   — one JSON line per non-title request received
//
// Reply shape: { text?: string, finish: "stop"|"length", usage?: {input,output} }
// Title-generation requests are auto-answered "E2E Title" and not recorded.

import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync } from "fs"
import path from "path"

const stateDir = process.argv[2]
if (!stateDir) throw new Error("usage: output-limit-fixture.ts <stateDir>")
mkdirSync(stateDir, { recursive: true })

type Reply = {
  text?: string
  finish: "stop" | "length"
  usage?: { input: number; output: number }
  // delay in ms between the role chunk and the rest, so PTY tests can
  // interrupt mid-stream
  delayMs?: number
}

function takeQueue(): Reply[] {
  const file = path.join(stateDir, "queue.json")
  if (!existsSync(file)) return []
  const items = JSON.parse(readFileSync(file, "utf8")) as Reply[]
  writeFileSync(file, "[]")
  return items
}

let queued = takeQueue()
let hits = 0
appendFileSync(path.join(stateDir, "server.log"), `fixture start queued=${queued.length}\n`)

function chunk(delta: Record<string, unknown>, finish?: string, usage?: { input: number; output: number }) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        }
      : {}),
  }
}

function sse(reply: Reply): string {
  const lines = [
    chunk({ role: "assistant" }),
    ...(reply.text ? [chunk({ content: reply.text })] : []),
    chunk({}, reply.finish, reply.usage),
  ]
  return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n"
}

function sseStream(reply: Reply): Response {
  const first = `data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`
  const rest =
    [
      ...(reply.text ? [chunk({ content: reply.text })] : []),
      chunk({}, reply.finish, reply.usage),
    ]
      .map((l) => `data: ${JSON.stringify(l)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  const encode = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encode.encode(first))
      // SSE comment keepalive every 5s so the server idle timeout does not
      // fire before the scripted delay elapses
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encode.encode(": keepalive\n\n"))
        } catch {
          clearInterval(keepalive)
        }
      }, 5000)
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs ?? 0))
      clearInterval(keepalive)
      try {
        controller.enqueue(encode.encode(rest))
        controller.close()
      } catch {
        // client aborted mid-wait; nothing left to send
      }
    },
    cancel() {
      // response body cancelled by the client (abort); do not treat as reset
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "POST" && url.pathname === "/control/reload") {
      queued = takeQueue()
      return Response.json({ queued: queued.length })
    }
    if (req.method === "GET" && url.pathname === "/control/pending") {
      return Response.json({ queued: queued.length })
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 })
    }
    const body = await req.json().catch(() => ({}))
    const isTitle = JSON.stringify(body).includes("Generate a title for this conversation")
    if (isTitle) {
      return new Response(sse({ text: "E2E Title", finish: "stop" }), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    const reply = queued.shift() ?? { text: "fixture: empty queue", finish: "stop" as const }
    hits += 1
    appendFileSync(
      path.join(stateDir, "hits.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), model: body.model, messages: body.messages?.length, finish: reply.finish, delayMs: reply.delayMs ?? 0, left: queued.length }) + "\n",
    )
    if (reply.delayMs) return sseStream(reply)
    return new Response(sse(reply), { headers: { "content-type": "text/event-stream" } })
  },
})

writeFileSync(path.join(stateDir, "port"), String(server.port))
console.log(`fixture listening on 127.0.0.1:${server.port}`)
