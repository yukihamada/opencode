import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { Spinner } from "./spinner"
import { askBtw, btwText, questionPreview, type BtwModelRef, type BtwResult } from "../util/btw"
import { formatSpend } from "../util/spend"

type Done = Extract<BtwResult, { usd: number }>

/**
 * The `/btw` panel. It sends one side request and shows the answer. Closing it
 * (esc) aborts a pending request, which also stops the server-side model call.
 * The main session keeps running underneath and nothing here writes to it.
 */
export function DialogBtw(props: {
  client: Parameters<typeof askBtw>[0]
  sessionID: string
  question: string
  main?: BtwModelRef
}) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const language = useLanguage()
  const dimensions = useTerminalDimensions()
  const text = () => btwText(language.current())
  const [result, setResult] = createSignal<BtwResult>()
  const width = createMemo(() => Math.min(88, dimensions().width) - 4)
  const maxHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height * 0.6)))
  let controller: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined

  const run = (approve = false) => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    setResult(undefined)
    void askBtw(props.client, {
      sessionID: props.sessionID,
      question: props.question,
      main: props.main,
      approve,
      signal: current.signal,
    }).then((next) => {
      if (!current.signal.aborted) setResult(next)
    })
  }

  onMount(() => {
    dialog.setSize("large")
    run()
  })
  onCleanup(() => controller?.abort())

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close side answer", group: "Dialog", cmd: () => dialog.clear() },
      { key: "up", desc: "Scroll side answer up", group: "Dialog", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll side answer down", group: "Dialog", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Scroll side answer up", group: "Dialog", cmd: () => scroll?.scrollBy(-maxHeight()) },
      { key: "pagedown", desc: "Scroll side answer down", group: "Dialog", cmd: () => scroll?.scrollBy(maxHeight()) },
      {
        key: "y",
        desc: "Approve this side question's cost",
        group: "Dialog",
        cmd: () => {
          if (result()?.type === "approval") run(true)
        },
      },
      {
        key: "r",
        desc: "Retry side question",
        group: "Dialog",
        cmd: () => {
          const current = result()
          if (current?.type === "empty" || current?.type === "error") run()
        },
      },
    ],
  }))

  const done = createMemo(() => {
    const current = result()
    return current && current.type !== "approval" ? (current as Done) : undefined
  })
  const answer = createMemo(() => {
    const current = done()
    return current?.type === "answer" || current?.type === "error" ? current.text : ""
  })
  const footer = () => {
    const current = done()
    if (!current) return text().note
    return [current.model, current.usd > 0 ? formatSpend(current.usd) : undefined, text().note].filter(Boolean).join(" · ")
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
          {text().title}
        </text>
        <text fg={theme.textMuted} flexShrink={0} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="none">
        › {questionPreview(props.question, width() - 2)}
      </text>
      <Show when={done()?.fallback}>
        <text fg={theme.warning} wrapMode="word">
          {text().fallback(done()!.model)}
        </text>
      </Show>
      <Switch>
        <Match when={!result()}>
          <Spinner>{text().thinking}</Spinner>
        </Match>
        <Match when={result()?.type === "approval" && result()}>
          {(current) => {
            const value = current() as Extract<BtwResult, { type: "approval" }>
            return (
              <box gap={1}>
                <text fg={theme.warning} wrapMode="word">
                  {text().approval(value.spent, value.limit, value.estimate)}
                </text>
                <text fg={theme.text}>{text().approve}</text>
              </box>
            )
          }}
        </Match>
        <Match when={result()?.type === "error" && result()}>
          {(current) => (
            <text fg={theme.error} wrapMode="word">
              {text().failed}: {(current() as Extract<BtwResult, { type: "error" }>).message} ({text().retry})
            </text>
          )}
        </Match>
        <Match when={result()?.type === "empty"}>
          <text fg={theme.warning} wrapMode="word">
            {text().empty} ({text().retry})
          </text>
        </Match>
      </Switch>
      <Show when={answer()}>
        <Show when={result()?.type === "error"}>
          <text fg={theme.textMuted}>{text().partial}</text>
        </Show>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => (scroll = el)}
          maxHeight={maxHeight()}
          contentOptions={{ minHeight: 0 }}
          scrollbarOptions={{ visible: false }}
        >
          <markdown
            syntaxStyle={syntax()}
            content={answer()}
            tableOptions={{ style: "grid" }}
            fg={theme.markdownText}
            bg={theme.backgroundPanel}
          />
        </scrollbox>
      </Show>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1} gap={2}>
        <text fg={theme.textMuted} wrapMode="word">
          {footer()}
        </text>
        <Show when={result()}>
          <text fg={theme.textMuted} flexShrink={0}>
            {text().close}
          </text>
        </Show>
      </box>
    </box>
  )
}
