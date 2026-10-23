import { expect } from "bun:test"
import { Effect } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { it } from "../../core/test/lib/effect"
import { makeOutputGate } from "../src/handlers/pty"

it.live("output gate terminates instead of dropping when a slow writer lets bytes pile up", () =>
  Effect.gen(function* () {
    const state = { ended: false, overflowed: false, detached: false }
    const gate = yield* makeOutputGate({
      limit: 16,
      onEnd: () => {
        state.ended = true
      },
      onOverflow: () => {
        state.overflowed = true
        state.detached = true
      },
    })

    // The consumer drains nothing, simulating a stalled websocket client.
    gate.offer("12345678")
    gate.offer("9012")
    expect(state.overflowed).toBeFalse()
    expect(yield* gate.take).toBe("12345678")
    expect(yield* gate.take).toBe("9012")

    gate.offer("12345678")
    gate.offer("90")
    gate.offer("this frame exceeds the remaining budget")
    expect(state.overflowed).toBeTrue()
    expect(state.detached).toBeTrue()

    // After overflow nothing new is enqueued except the terminating close frame.
    gate.offer("late chunk")
    gate.end()
    expect(state.ended).toBeFalse()

    expect(yield* gate.take).toBe("12345678")
    expect(yield* gate.take).toBe("90")
    const close = yield* gate.take
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(1013)
  }),
)

it.live("output gate passes frames through in order and closes cleanly under the limit", () =>
  Effect.gen(function* () {
    const state = { ended: false, overflowed: false }
    const gate = yield* makeOutputGate({
      limit: 8,
      onEnd: () => {
        state.ended = true
      },
      onOverflow: () => {
        state.overflowed = true
      },
    })

    gate.offer("ab")
    gate.offer(new Uint8Array([99, 100]))
    gate.end()
    expect(state.ended).toBeTrue()
    expect(state.overflowed).toBeFalse()

    expect(yield* gate.take).toBe("ab")
    expect(yield* gate.take).toEqual(new Uint8Array([99, 100]))
    const close = yield* gate.take
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(1000)
  }),
)

it.live("output gate accounts for UTF-8 bytes instead of JavaScript string length", () =>
  Effect.gen(function* () {
    const state = { overflowed: false }
    const gate = yield* makeOutputGate({
      limit: 4,
      onEnd: () => {},
      onOverflow: () => {
        state.overflowed = true
      },
    })

    gate.offer("あ") // three UTF-8 bytes
    expect(state.overflowed).toBeFalse()
    gate.offer("い") // total would be six bytes, despite only two JS characters
    expect(state.overflowed).toBeTrue()
    expect(yield* gate.take).toBe("あ")
    const close = yield* gate.take
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(1013)
  }),
)
