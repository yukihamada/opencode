/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RenderableEvents, TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { createSenteKeymap } from "../src/keymap-host"

// 入力欄には11層以上のキー割り当てが正当に重なる。既定上限10のままだと
// 起動のたびに MaxListenersExceededWarning が画面下に出ていたので、その回帰を止める。
const LAYERS = 12

function Harness(props: { factory: "default" | "sente"; onTarget: (target: TextareaRenderable) => void }) {
  const renderer = useRenderer()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const keymap = props.factory === "sente" ? createSenteKeymap(renderer) : createDefaultOpenTuiKeymap(renderer)
  const offs: (() => void)[] = []

  createEffect(() => {
    const node = target()
    if (!node || offs.length > 0) return
    for (let i = 0; i < LAYERS; i++) {
      offs.push(
        keymap.registerLayer({
          target: node,
          bindings: [{ key: `ctrl+${i % 10}`, cmd: () => {} }],
        }),
      )
    }
    props.onTarget(node)
  })

  onCleanup(() => {
    for (const off of offs) off()
  })

  return (
    <textarea
      height={3}
      ref={(node: TextareaRenderable) => {
        setTarget(node)
      }}
    />
  )
}

async function mount(factory: "default" | "sente") {
  const warnings: string[] = []
  const onWarning = (warning: Error) => warnings.push(String(warning))
  process.on("warning", onWarning)
  let target: TextareaRenderable | undefined
  const app = await testRender(() => <Harness factory={factory} onTarget={(value) => (target = value)} />)
  // process.emitWarning は次のティックで届くので、判定前に一度待つ。
  await Bun.sleep(20)
  return { app, warnings, target: target! }
}

test("default keymap warns once a textarea carries more than 10 destroy subscriptions", async () => {
  const { app, warnings, target } = await mount("default")
  try {
    expect(target.listenerCount(RenderableEvents.DESTROYED)).toBeGreaterThan(10)
    expect(warnings.some((warning) => warning.includes("MaxListenersExceededWarning"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("createSenteKeymap raises the limit so a textarea with 12 layers stays quiet", async () => {
  const { app, warnings, target } = await mount("sente")
  try {
    expect(target.listenerCount(RenderableEvents.DESTROYED)).toBeGreaterThan(10)
    expect(target.getMaxListeners()).toBeGreaterThanOrEqual(target.listenerCount(RenderableEvents.DESTROYED))
    expect(warnings.filter((warning) => warning.includes("MaxListenersExceededWarning"))).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
