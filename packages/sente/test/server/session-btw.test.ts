import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Database } from "@sente-ai/core/database/database"
import { Ripgrep } from "@sente-ai/core/ripgrep"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionBtw } from "@/session/btw"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
    ],
  ],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Answer = {
  text: string
  providerID: string
  modelID: string
  cost: number
  tokens: { input: number; output: number }
  approval?: { spent: number; limit: number; estimate?: number }
  error?: string
}

// The main model plus a cheaper `small_model`. Both have prices so the side
// call's cost can be checked.
function config(url: string) {
  const base = testProviderConfig(url)
  const model = base.provider.test.models["test-model"]
  return {
    ...base,
    small_model: "test/test-small",
    provider: {
      test: {
        ...base.provider.test,
        models: {
          "test-model": { ...model, cost: { input: 10, output: 30 } },
          "test-small": { ...model, id: "test-small", name: "Test Small", cost: { input: 1, output: 2 } },
        },
      },
    },
  }
}

function post(path: string, directory: string, body: unknown, method = "POST") {
  const url = new URL(`${path}?directory=${encodeURIComponent(directory)}`, "http://localhost")
  return HttpClientRequest.fromWeb(
    new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  ).pipe(HttpClientRequest.setUrl(url.pathname), HttpClient.execute)
}

function answer(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as Answer))
}

const isSide = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("side_question")
const isMain = (hit: { body: Record<string, unknown> }) => {
  const body = JSON.stringify(hit.body)
  return body.includes("MAIN-TASK") && !body.includes("side_question") && !body.includes("first_request")
}

describe("session /btw", () => {
  it.live(
    "answers while the main prompt is running, without tools and without touching history",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
        const session = yield* Session.use.create({ title: "Fix the login form" }).pipe(provideInstanceEffect(directory))

        let release = () => {}
        const held = new Promise<void>((resolve) => (release = resolve))
        yield* llm.pushMatch(isMain, reply().wait(held).text("main done").stop())
        yield* llm.textMatch(isSide, "<think>hidden</think>It is fixing the login form.", {
          usage: { input: 1000, output: 100 },
        })

        const started = yield* post(SessionPaths.promptAsync.replace(":sessionID", session.id), directory, {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "MAIN-TASK: fix the login form" }],
        })
        expect(started.status).toBe(204)

        // Wait until the main request is actually streaming (held open).
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const hits = yield* llm.hits
            return hits.some(isMain) ? true : undefined
          }),
          "main request never started",
        )

        const side = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, {
          question: "What is it doing right now?",
        }).pipe(Effect.flatMap(answer))

        expect(side.error).toBeUndefined()
        expect(side.text).toBe("It is fixing the login form.")
        // Cheap model by default (config small_model), priced at its own rate.
        expect(side.modelID).toBe("test-small")
        expect(side.cost).toBeCloseTo((1000 * 1 + 100 * 2) / 1_000_000, 10)

        const request = (yield* llm.hits).find(isSide)!.body
        const text = JSON.stringify(request)
        expect(request.model).toBe("test-small")
        expect(request.tools).toBeUndefined()
        expect(text).toContain("MAIN-TASK: fix the login form")
        expect(text).toContain("Fix the login form")
        expect(text).toContain("What is it doing right now?")

        // The main request is still held open: the side answer did not wait for it.
        expect((yield* llm.hits).filter(isMain)).toHaveLength(1)
        const during = yield* Session.use.messages({ sessionID: session.id }).pipe(provideInstanceEffect(directory))
        expect(JSON.stringify(during)).not.toContain("main done")

        release()
        // The main run was not aborted by the side call and finishes normally.
        const history = yield* pollWithTimeout(
          Session.use.messages({ sessionID: session.id }).pipe(
            provideInstanceEffect(directory),
            Effect.map((messages) => (JSON.stringify(messages).includes("main done") ? messages : undefined)),
          ),
          "main prompt never finished",
        )
        const all = JSON.stringify(history)
        expect(all).not.toContain("What is it doing right now?")
        expect(all).not.toContain("It is fixing the login form.")
        expect(all).toContain("main done")
        expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)

        // The side cost is on the session (metadata), so the limit and sidebar count it.
        const after = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory))
        expect(SessionBtw.spentOn(after.metadata)).toBeCloseTo(side.cost, 10)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live("returns an empty answer as empty text, not an error", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      yield* llm.textMatch(isSide, "   ")

      const side = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, {
        question: "anything?",
      }).pipe(Effect.flatMap(answer))
      expect(side.text).toBe("")
      expect(side.error).toBeUndefined()
      expect(JSON.stringify((yield* llm.hits).find(isSide)!.body)).toContain("(no messages yet)")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("reports a provider failure in `error`", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      yield* llm.pushMatch(isSide, httpError(402, { error: { message: "Insufficient credits" } }))

      const side = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, {
        question: "anything?",
      }).pipe(Effect.flatMap(answer))
      expect(side.text).toBe("")
      expect(side.error).toBeString()
      expect(side.error!.length).toBeGreaterThan(0)
      expect(side.cost).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("rejects a blank question", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      const response = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, { question: "   " })
      expect(response.status).toBe(400)
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("an unknown session is a 404", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const response = yield* post(SessionPaths.btw.replace(":sessionID", "ses_doesnotexist"), directory, { question: "hi" })
      expect(response.status).toBe(404)
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("an explicit model that does not exist is an error, with no model call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      const side = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, {
        question: "hi",
        model: { providerID: "test", modelID: "nope" },
      }).pipe(Effect.flatMap(answer))
      expect(side.error).toContain("test/nope")
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("over the session cost limit it asks for approval first, and runs once approved", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      // $0.001 limit, with earlier /btw spend already at it.
      const session = yield* Session.use
        .create({ metadata: SessionBtw.withSpend({ cost_limit_usd: 0.001 }, 0.001, Date.now()) })
        .pipe(provideInstanceEffect(directory))
      const path = SessionPaths.btw.replace(":sessionID", session.id)

      const blocked = yield* post(path, directory, { question: "hi" }).pipe(Effect.flatMap(answer))
      expect(blocked.approval).toBeDefined()
      expect(blocked.approval!.limit).toBeCloseTo(0.001)
      expect(blocked.approval!.spent).toBeCloseTo(0.001)
      expect(blocked.text).toBe("")
      expect(yield* llm.calls).toBe(0)

      yield* llm.textMatch(isSide, "approved answer", { usage: { input: 10, output: 10 } })
      const approved = yield* post(path, directory, { question: "hi", approve: true }).pipe(Effect.flatMap(answer))
      expect(approved.approval).toBeUndefined()
      expect(approved.text).toBe("approved answer")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live(
    "aborting the HTTP request stops the side call and records what was spent",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
        const session = yield* Session.use.create({ title: "Goal" }).pipe(provideInstanceEffect(directory))
        yield* llm.pushMatch(isSide, reply().wait(new Promise(() => {})).text("never").stop())

        const fiber = yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, { question: "slow?" }).pipe(
          Effect.forkChild,
        )
        yield* pollWithTimeout(
          llm.hits.pipe(Effect.map((hits) => (hits.some(isSide) ? true : undefined))),
          "side request never started",
        )
        yield* Fiber.interrupt(fiber)

        // The server handler was interrupted: it recorded an estimate of the spend.
        const spent = yield* pollWithTimeout(
          Session.use.get(session.id).pipe(
            provideInstanceEffect(directory),
            Effect.map((info) => (SessionBtw.spentOn(info.metadata) > 0 ? SessionBtw.spentOn(info.metadata) : undefined)),
          ),
          "abort did not reach the server handler",
        )
        expect(spent).toBeGreaterThan(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    20_000,
  )

  it.live("client metadata updates (PATCH, the /cost screen's stale copy) cannot overwrite or delete btw_spend", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      yield* llm.textMatch(isSide, "ok", { usage: { input: 1000, output: 100 } })
      yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, { question: "hi" }).pipe(Effect.flatMap(answer))
      const spent = SessionBtw.spentOn((yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory))).metadata)
      expect(spent).toBeGreaterThan(0)

      const path = SessionPaths.update.replace(":sessionID", session.id)
      // The /cost screen sends its (possibly stale) copy of the whole metadata.
      expect((yield* post(path, directory, { metadata: { cost_limit_usd: 2 } }, "PATCH")).status).toBe(200)
      // A client trying to reset or replace it.
      expect((yield* post(path, directory, { metadata: { btw_spend: null } }, "PATCH")).status).toBe(200)
      expect((yield* post(path, directory, { metadata: { btw_spend: { total: 0, recent: [] }, cost_limit_usd: 3 } }, "PATCH")).status).toBe(200)

      const after = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory))
      expect(SessionBtw.spentOn(after.metadata)).toBeCloseTo(spent, 12)
      expect(after.metadata?.cost_limit_usd).toBe(3)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("recording a side cost does not change time.updated (the session list order)", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(directory))
      yield* llm.textMatch(isSide, "ok", { usage: { input: 1000, output: 100 } })
      yield* Effect.sleep("20 millis")
      yield* post(SessionPaths.btw.replace(":sessionID", session.id), directory, { question: "hi" }).pipe(Effect.flatMap(answer))
      const after = yield* Session.use.get(session.id).pipe(provideInstanceEffect(directory))
      expect(SessionBtw.spentOn(after.metadata)).toBeGreaterThan(0)
      expect(after.time.updated).toBe(session.time.updated)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  // Session routes are always served in the session's own directory/project
  // (workspace-routing uses session.directory), so asking through another
  // project's directory cannot run or bill under that project's config. The
  // handler's projectID check is a second guard behind that routing.
  it.live("a session asked through another project's directory runs only under its own project", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const own = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const other = yield* tmpdirScoped({ git: true, config: { ...config(llm.url), small_model: "test/test-model" } })
      const session = yield* Session.use.create({}).pipe(provideInstanceEffect(own))
      yield* llm.textMatch(isSide, "ok", { usage: { input: 1000, output: 100 } })
      const side = yield* post(SessionPaths.btw.replace(":sessionID", session.id), other, { question: "hi" }).pipe(Effect.flatMap(answer))
      expect(side.modelID).toBe("test-small")
      const after = yield* Session.use.get(session.id).pipe(provideInstanceEffect(own))
      expect(SessionBtw.spentOn(after.metadata)).toBeCloseTo(side.cost, 12)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("request_cost rules: deny refuses over the limit even with approve, allow runs without asking", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: config(llm.url) })
      const over = SessionBtw.withSpend({ cost_limit_usd: 0.001 }, 0.001, Date.now())
      const denied = yield* Session.use
        .create({ metadata: over, permission: [{ permission: "request_cost", pattern: "*", action: "deny" }] })
        .pipe(provideInstanceEffect(directory))
      const refused = yield* post(SessionPaths.btw.replace(":sessionID", denied.id), directory, { question: "hi", approve: true }).pipe(
        Effect.flatMap(answer),
      )
      expect(refused.error).toContain("deny")
      expect(refused.approval).toBeUndefined()
      expect(yield* llm.calls).toBe(0)

      const allowed = yield* Session.use
        .create({ metadata: over, permission: [{ permission: "request_cost", pattern: "*", action: "allow" }] })
        .pipe(provideInstanceEffect(directory))
      yield* llm.textMatch(isSide, "allowed answer")
      const ran = yield* post(SessionPaths.btw.replace(":sessionID", allowed.id), directory, { question: "hi" }).pipe(Effect.flatMap(answer))
      expect(ran.approval).toBeUndefined()
      expect(ran.text).toBe("allowed answer")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )
})
