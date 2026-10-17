import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import os from "node:os"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Config } from "@/config/config"

const ConfigNode = Config.node

/**
 * Host-resource aware admission control for concurrent subagents.
 *
 * Sente work defaults to agent execution, and agents are expected to run in
 * parallel. Without a cap, a user asking for many parallel tasks on a loaded
 * Mac can push the machine into thrash. This service samples host load and
 * memory, derives a concurrency limit, and hands out semaphore permits sized
 * to that limit. The limit is re-derived on every acquire so a busy machine
 * shrinks admission automatically and recovers when the load clears.
 */

export interface ResourcesConfig {
  /** Hard ceiling for concurrent subagents regardless of load. Default: min(CPU count, 8). */
  maxConcurrent?: number
  /** Disable auto-tuning and always allow `maxConcurrent` (or the default). */
  disabled?: boolean
  /** Free memory below which only one subagent may run. Default: 1536 MB. */
  lowMemoryMB?: number
  /**
   * Load average (1 min) per CPU core above which admission shrinks.
   * At 1.5x cores only one subagent runs. Default: 1.0.
   */
  loadFactor?: number
}

export interface Snapshot {
  cores: number
  loadavg1: number
  loadPerCore: number
  freeMemoryMB: number
  limit: number
  running: number
}

export interface Interface {
  /** Run `effect` while holding one subagent slot, waiting when the host is busy. */
  readonly withSlot: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Current host reading and derived limit, for surfaces and tests. */
  readonly snapshot: Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@sente/HostResources") {}

const DEFAULT_LOW_MEMORY_MB = 1536
const DEFAULT_LOAD_FACTOR = 1.0
const ABSOLUTE_MAX = 32

function deriveLimit(input: {
  cores: number
  loadPerCore: number
  freeMemoryMB: number
  config: ResourcesConfig
}): number {
  const ceiling = Math.max(1, Math.min(input.config.maxConcurrent ?? Math.min(input.cores, 8), ABSOLUTE_MAX))
  if (input.config.disabled) return ceiling
  if (input.freeMemoryMB < (input.config.lowMemoryMB ?? DEFAULT_LOW_MEMORY_MB)) return 1
  const loadFactor = input.config.loadFactor ?? DEFAULT_LOAD_FACTOR
  // loadPerCore <= factor -> full ceiling; >= 1.5x factor -> 1; linear in between.
  const pressure = input.loadPerCore / loadFactor
  if (pressure <= 1) return ceiling
  if (pressure >= 1.5) return 1
  const scaled = Math.round(ceiling * (1.5 - pressure) * 2)
  return Math.max(1, Math.min(ceiling, scaled))
}

function sample(cores: number) {
  const loadavg1 = os.loadavg()[0] ?? 0
  return {
    cores,
    loadavg1,
    loadPerCore: cores > 0 ? loadavg1 / cores : 0,
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
  }
}

export const make = (
  config: ResourcesConfig = {},
  readConfig: () => Effect.Effect<ResourcesConfig | undefined> = () => Effect.succeed(undefined),
): Interface => {
  // Generous fixed semaphore; the effective limit is enforced by taking extra
  // permits when the derived limit shrinks, so it can tighten without waiting
  // for a semaphore resize.
  const semaphore = Semaphore.makeUnsafe(ABSOLUTE_MAX)
  const running = Ref.makeUnsafe(0)

  const currentLimit = Effect.map(readConfig(), (override) => {
    const merged = { ...config, ...override }
    const reading = sample(os.cpus().length || 1)
    const limit = deriveLimit({ ...reading, config: merged })
    return { ...reading, limit }
  })

  const withSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(currentLimit, ({ limit }) => {
        const permits = ABSOLUTE_MAX - limit + 1
        return semaphore.withPermits(permits)(
          Effect.andThen(Ref.update(running, (n) => n + 1), restore(effect)).pipe(
            Effect.ensuring(Ref.update(running, (n) => n - 1)),
          ),
        )
      }),
    )

  const snapshot = Effect.all([currentLimit, Ref.get(running)]).pipe(
    Effect.map(([reading, n]) => ({ ...reading, running: n })),
  )

  return { withSlot, snapshot }
}

export const layer = (config: ResourcesConfig = {}) => Layer.succeed(Service, make(config))

/** Pure derivation, exported for tests. */
export const limitFor = deriveLimit

// Config resolution needs an instance context that headless/test runtimes may
// not provide, and a config failure must never take down the admission gate —
// so resolve config lazily per sample and fall back to defaults on any error.
const configLayer = Layer.effect(
  Service,
  Effect.map(Config.Service, (config) =>
    make(
      {},
      () =>
        config.get().pipe(
          Effect.map((cfg) => ({
            maxConcurrent: cfg.resources?.max_concurrent_subagents,
            disabled: cfg.resources?.disable_auto_throttle,
            lowMemoryMB: cfg.resources?.low_memory_mb,
            loadFactor: cfg.resources?.load_factor,
          })),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
    ),
  ),
)

export const node = LayerNode.make({ service: Service, layer: configLayer, deps: [ConfigNode] })

export * as HostResources from "./host-resources"
