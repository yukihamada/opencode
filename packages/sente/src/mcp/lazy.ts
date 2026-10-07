import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { ServerCapabilities, Tool } from "@modelcontextprotocol/sdk/types.js"
import { Global } from "@sente-ai/core/global"

const DEFAULT_IDLE = 10 * 60_000
const MAX_AGE = 7 * 24 * 60 * 60_000

type Prompts = Awaited<ReturnType<Client["listPrompts"]>>["prompts"]
type Resources = Awaited<ReturnType<Client["listResources"]>>["resources"]
type ResourceTemplates = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"]

/** What a local server told us last time, so a session can list its tools without starting the process. */
export interface Snapshot {
  time: number
  capabilities?: ServerCapabilities
  instructions?: string
  defs: Tool[]
  prompts?: Prompts
  resources?: Resources
  resourceTemplates?: ResourceTemplates
}

/** How long a local server may sit unused before its process is stopped. `SENTE_MCP_IDLE_MS=0` keeps the old always-running behavior. */
export function idle(env: Record<string, string | undefined>) {
  if (env.SENTE_MCP_IDLE_MS === undefined) return DEFAULT_IDLE
  const value = Number(env.SENTE_MCP_IDLE_MS)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE
}

// Tool lists can depend on the working directory and environment, so both are part of the identity.
export function key(input: { command: string[]; cwd: string; environment?: Record<string, string> }) {
  return createHash("sha256")
    .update(JSON.stringify([input.command, input.cwd, Object.entries(input.environment ?? {}).sort()]))
    .digest("hex")
}

function file(id: string) {
  return path.join(Global.Path.cache, "mcp-snapshot", id + ".json")
}

export async function read(id: string) {
  const snapshot: Snapshot | undefined = await Bun.file(file(id))
    .json()
    .catch(() => undefined)
  if (!snapshot || !Array.isArray(snapshot.defs) || typeof snapshot.time !== "number") return undefined
  if (Date.now() - snapshot.time > MAX_AGE) return undefined
  return snapshot
}

export async function write(id: string, snapshot: Snapshot) {
  await mkdir(path.dirname(file(id)), { recursive: true })
  await Bun.write(file(id), JSON.stringify(snapshot))
}

/**
 * Stands in for a local server's client. The process is started on the first request and stopped after
 * `idle` ms without one; capabilities and list results come from the snapshot while it is stopped.
 */
export class LazyClient extends Client {
  private real: Client | undefined
  private waking: Promise<Client> | undefined
  private busy = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly input: {
      snapshot: Snapshot
      idle: number
      start: () => Promise<Client>
      stop: (client: Client) => Promise<void>
    },
    real?: Client,
  ) {
    super({ name: "sente-lazy", version: "0" })
    // Assigned rather than overridden: these are overloaded on Client and every one must reach the real client.
    this.request = ((request, schema, options) =>
      this.use((client) => client.request(request, schema, options))) as Client["request"]
    this.callTool = ((...args: Parameters<Client["callTool"]>) =>
      this.use((client) => client.callTool(...args))) as Client["callTool"]
    this.listTools = ((params, options) => this.use((client) => client.listTools(params, options))) as Client["listTools"]
    this.getPrompt = ((params, options) => this.use((client) => client.getPrompt(params, options))) as Client["getPrompt"]
    this.readResource = ((params, options) =>
      this.use((client) => client.readResource(params, options))) as Client["readResource"]
    this.listPrompts = ((params, options) => {
      const cached = this.cached(this.snapshot.prompts, params)
      if (cached) return Promise.resolve({ prompts: cached })
      return this.use((client) => client.listPrompts(params, options))
    }) as Client["listPrompts"]
    this.listResources = ((params, options) => {
      const cached = this.cached(this.snapshot.resources, params)
      if (cached) return Promise.resolve({ resources: cached })
      return this.use((client) => client.listResources(params, options))
    }) as Client["listResources"]
    this.listResourceTemplates = ((params, options) => {
      const cached = this.cached(this.snapshot.resourceTemplates, params)
      if (cached) return Promise.resolve({ resourceTemplates: cached })
      return this.use((client) => client.listResourceTemplates(params, options))
    }) as Client["listResourceTemplates"]
    if (!real) return
    this.attach(real)
    this.arm()
  }

  get snapshot() {
    return this.input.snapshot
  }

  set snapshot(value: Snapshot) {
    this.input.snapshot = value
  }

  get running() {
    return this.real !== undefined
  }

  override get transport() {
    return this.real?.transport
  }

  override getServerCapabilities() {
    return this.real?.getServerCapabilities() ?? this.snapshot.capabilities
  }

  override getInstructions() {
    return this.real?.getInstructions() ?? this.snapshot.instructions
  }

  override getServerVersion() {
    return this.real?.getServerVersion()
  }

  override async close() {
    this.disposed = true
    clearTimeout(this.timer)
    await this.waking?.catch(() => undefined)
    await this.sleep()
  }

  /** Stop the process now if nothing is using it. The next request starts it again. */
  async sleep() {
    if (this.busy > 0 || !this.real) return
    const client = this.real
    this.real = undefined
    await this.input.stop(client).catch(() => undefined)
  }

  private cached<T>(items: T[] | undefined, params: { cursor?: string } | undefined) {
    if (this.real || params?.cursor !== undefined) return undefined
    return items
  }

  private async use<A>(fn: (client: Client) => Promise<A>) {
    this.busy++
    clearTimeout(this.timer)
    try {
      return await fn(await this.wake())
    } finally {
      this.busy--
      this.arm()
    }
  }

  private wake() {
    if (this.disposed) return Promise.reject(new Error("MCP client closed"))
    if (this.real) return Promise.resolve(this.real)
    this.waking ??= this.input
      .start()
      .then(async (client) => {
        if (this.disposed) {
          await this.input.stop(client).catch(() => undefined)
          throw new Error("MCP client closed")
        }
        this.attach(client)
        return client
      })
      .finally(() => {
        this.waking = undefined
      })
    return this.waking
  }

  private attach(client: Client) {
    this.real = client
    // A crashed server is only forgotten; the next request starts a fresh one.
    client.onclose = () => {
      if (this.real === client) this.real = undefined
    }
  }

  private arm() {
    clearTimeout(this.timer)
    if (this.disposed || this.busy > 0 || !this.real) return
    this.timer = setTimeout(() => void this.sleep(), this.input.idle)
    this.timer.unref?.()
  }
}

export * as McpLazy from "./lazy"
