import type { SessionV1 } from "@sente-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { Storage } from "@/storage/storage"

export class Stopped extends Schema.TaggedErrorClass<Stopped>()("EconomyStopped", {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

const Reservation = Schema.Struct({
  id: Schema.String,
  reserve: Schema.Number,
})

const Completion = Schema.Struct({
  model: Schema.String,
  cost: Schema.Number,
  reserve: Schema.Number,
  complete: Schema.Boolean,
  stopped: Schema.Boolean,
  failures: Schema.Array(Schema.String),
})

export function ledgerKey(sessionID: string, userID: string) {
  return ["economy", "v1", sessionID, userID]
}

export const load = Effect.fn("Economy.load")(function* (
  sessionID: string,
  userID: string,
  config: Config | undefined,
  messages: SessionV1.WithParts[],
) {
  const storage = yield* Storage.Service
  const key = ledgerKey(sessionID, userID)
  const recorded = yield* storage.read<unknown>([...key, "config"]).pipe(
    Effect.map(Option.some),
    Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(Option.none())),
    Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
    Effect.orDie,
  )
  if (Option.isSome(recorded) && recorded.value !== JSON.stringify(config))
    throw new Stopped("Economy: configuration changed; resume refused")
  if (!config) return []
  if (Option.isNone(recorded)) {
    if (messages.length) throw new Stopped("Economy: missing ledger; resume refused")
    yield* storage.create([...key, "config"], JSON.stringify(config)).pipe(
      Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
      Effect.orDie,
    )
  }
  const pending = yield* storage.read<unknown>([...key, String(messages.length), "reservation"]).pipe(
    Effect.map(Option.some),
    Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(Option.none())),
    Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
    Effect.orDie,
  )
  if (Option.isSome(pending)) throw new Stopped("Economy: unsettled reservation; resume refused")
  return yield* Effect.forEach(
    messages,
    Effect.fnUntraced(function* (message, index) {
      const reservation = yield* storage.read([...key, String(index), "reservation"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Reservation)),
        Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
        Effect.orDie,
      )
      const completed = yield* storage.read([...key, String(index), "completion"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Completion)),
        Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
        Effect.orDie,
      )
      if (
        message.info.role !== "assistant" ||
        reservation.id !== message.info.id ||
        completed.reserve !== reservation.reserve
      )
        throw new Stopped("Economy: inconsistent ledger; resume refused")
      return { ...completed, failures: [...completed.failures] }
    }),
  )
})

export const admit = Effect.fn("Economy.admit")(function* (
  sessionID: string,
  userID: string,
  index: number,
  reservation: typeof Reservation.Type,
) {
  const storage = yield* Storage.Service
  yield* storage.create([...ledgerKey(sessionID, userID), String(index), "reservation"], reservation).pipe(
    Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
    Effect.orDie,
  )
})

export const settle = Effect.fn("Economy.settle")(function* (
  sessionID: string,
  userID: string,
  index: number,
  turn: Turn,
) {
  const storage = yield* Storage.Service
  yield* storage.create([...ledgerKey(sessionID, userID), String(index), "completion"], turn).pipe(
    Effect.mapError(() => new Stopped("Economy: ledger unavailable or invalid; resume refused")),
    Effect.orDie,
  )
})

export type Config = {
  verification: { command: string; cwd: string }[]
  models: string[]
  maxUsd: number
  maxTurns: number
  maxEscalations: number
}

export type Turn = {
  model: string
  cost: number
  reserve: number
  complete: boolean
  stopped: boolean
  failures: string[]
}

export function next(config: Config, turns: Turn[], reserve: (tier: number) => number) {
  if (
    config.verification.length === 0 ||
    config.verification.some((spec) => !spec.command.trim() || !path.isAbsolute(spec.cwd)) ||
    config.models.length === 0 ||
    config.models.some((model) => !model.trim() || model !== model.trim()) ||
    new Set(config.models).size !== config.models.length ||
    !Number.isFinite(config.maxUsd) ||
    config.maxUsd <= 0 ||
    !Number.isSafeInteger(config.maxTurns) ||
    config.maxTurns < 1 ||
    !Number.isSafeInteger(config.maxEscalations) ||
    config.maxEscalations < 0
  )
    throw new Stopped("Economy: invalid limits or model ladder")
  let tier = 0
  let charged = 0
  let previous = new Set<string>()
  let repeated = false
  for (const turn of turns) {
    if (repeated) {
      tier++
      previous = new Set()
    }
    if (config.models.indexOf(turn.model) !== tier || tier > config.maxEscalations)
      throw new Stopped("Economy: inconsistent model history")
    if (!turn.complete || turn.stopped) throw new Stopped("Economy: interrupted or stopped turn; resume refused")
    if (!Number.isFinite(turn.cost) || turn.cost < 0 || !Number.isFinite(turn.reserve) || turn.reserve < 0)
      throw new Stopped("Economy: unknown cost")
    if (turn.failures.some((key) => !key.trim())) throw new Stopped("Economy: invalid failure evidence")
    charged += Math.max(turn.cost, turn.reserve)
    repeated = turn.failures.some((key) => previous.has(key))
    previous = new Set(turn.failures)
  }
  if (turns.length >= config.maxTurns) throw new Stopped("Economy: provider turn limit reached")
  if (repeated) {
    if (tier >= config.maxEscalations || tier + 1 >= config.models.length)
      throw new Stopped("Economy: escalation limit reached; verification remains unconfirmed")
    tier++
  }
  const reserved = reserve(tier)
  if (!Number.isFinite(reserved) || reserved < 0) throw new Stopped("Economy: unknown model price or limits")
  if (!Number.isFinite(charged) || charged + reserved > config.maxUsd)
    throw new Stopped("Economy: estimated reservation budget exhausted; not an invoice guarantee")
  return { tier, reserve: reserved }
}

export const key = "sente.economy.v1"

export function reserve(model: Provider.Model) {
  const prices = [
    model.cost,
    ...(model.cost.tiers ?? []),
    ...(model.cost.experimentalOver200K ? [model.cost.experimentalOver200K] : []),
  ]
  if (
    !Number.isSafeInteger(model.limit.context) ||
    model.limit.context <= 0 ||
    !Number.isSafeInteger(model.limit.output) ||
    model.limit.output <= 0 ||
    prices.some(
      (price) =>
        !Number.isFinite(price.input) ||
        price.input <= 0 ||
        !Number.isFinite(price.output) ||
        price.output <= 0 ||
        !Number.isFinite(price.cache.read) ||
        price.cache.read < 0 ||
        !Number.isFinite(price.cache.write) ||
        price.cache.write < 0,
    )
  )
    return NaN
  return (
    (model.limit.context * Math.max(...prices.flatMap((price) => [price.input, price.cache.read, price.cache.write])) +
      model.limit.output * Math.max(...prices.map((price) => price.output))) /
    1_000_000
  )
}

export function evidence(message: SessionV1.WithParts, reserved: number, verification: Config["verification"]): Turn {
  if (message.info.role !== "assistant") throw new Stopped("Economy: invalid assistant history")
  const tools = message.parts.filter((part) => part.type === "tool")
  const results = new Map<string, { exit: number; end: number }>()
  const approved = new Set(verification.map((spec) => JSON.stringify([spec.command, path.resolve(spec.cwd)])))
  let stopped = !!message.info.error || message.info.finish === "content-filter"
  for (const part of tools) {
    if (part.state.status !== "completed" || part.metadata?.providerExecuted) {
      stopped = true
      continue
    }
    if (part.tool !== "bash") continue
    const exit = part.state.metadata.exit
    const command = part.state.input.command
    const workdir = part.state.input.workdir ?? message.info.path.cwd
    if (!Number.isSafeInteger(exit) || typeof command !== "string" || !command.trim() || typeof workdir !== "string") {
      stopped = true
      continue
    }
    const fingerprint = JSON.stringify([command, path.resolve(message.info.path.cwd, workdir)])
    if (!approved.has(fingerprint)) continue
    const end = part.state.time.end
    const previous = results.get(fingerprint)
    if (!Number.isFinite(end) || previous?.end === end) {
      stopped = true
      continue
    }
    if (!previous || end > previous.end) results.set(fingerprint, { exit, end })
  }
  return {
    model: `${message.info.providerID}/${message.info.modelID}`,
    cost: message.info.cost,
    reserve: reserved,
    complete: !!message.info.time.completed && !!message.info.finish,
    stopped,
    failures: [...results].filter(([, result]) => result.exit !== 0).map(([key]) => key),
  }
}

export * as Economy from "./economy"
