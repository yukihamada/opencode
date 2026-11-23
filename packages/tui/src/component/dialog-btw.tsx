import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { Spinner } from "./spinner"
import { askBtw, btwText, type BtwResult } from "../util/btw"
import { formatSpend } from "../util/spend"

/**
 * The `/btw` panel. It sends one side request and shows the answer; closing it
 * (esc) aborts a pending request. The main session keeps running underneath
 * and nothing here writes to it.
 */
export function DialogBtw(props: {
  client: Parameters<typeof askBtw>[0]
  sessionID: string
  question: string
  onSpend: (usd: number) => void
}) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const language = useLanguage()
  const dimensions = useTerminalDimensions()
  const text = () => btwText(language.current())
  const [result, setResult] = createSignal<BtwResult>()
  let controller: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined

  const run = () => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    setResult(undefined)
    void askBtw(props.client, { sessionID: props.sessionID, question: props.question, signal: current.signal }).then(
      (next) => {
        if (current.signal.aborted) return
        if (next.type !== "error" && next.usd > 0) props.onSpend(next.usd)
        setResult(next)
      },
    )
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
      { key: "pageup", desc: "Scroll side answer up", group: "Dialog", cmd: () => scroll?.scrollBy(-10) },
      { key: "pagedown", desc: "Scroll side answer down", group: "Dialog", cmd: () => scroll?.scrollBy(10) },
      {
        key: "r",
        desc: "Retry side question",
        group: "Dialog",
        cmd: () => {
          const current = result()
          if (current && current.type !== "answer") run()
        },
      },
    ],
  }))

  // Fit the panel to the answer (wrapped at the large dialog's width), up to 60% of the screen; longer answers scroll.
  const answerHeight = (answer: string) => {
    const lines = answer.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Bun.stringWidth(line) / 80)), 0)
    return Math.min(lines + 1, Math.max(6, Math.floor(dimensions().height * 0.6)))
  }

  const footer = () => {
    const current = result()
    if (!current || current.type === "error") return text().note
    return [current.model, current.usd > 0 ? formatSpend(current.usd) : undefined, text().note]
      .filter(Boolean)
      .join(" · ")
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {text().title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        › {props.question}
      </text>
      <Switch>
        <Match when={!result()}>
          <Spinner>{text().thinking}</Spinner>
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
        <Match when={result()?.type === "answer" && result()}>
          {(current) => (
            <scrollbox ref={(el: ScrollBoxRenderable) => (scroll = el)} height={answerHeight((current() as Extract<BtwResult, { type: "answer" }>).text)} scrollbarOptions={{ visible: false }}>
              <markdown
                syntaxStyle={syntax()}
                content={(current() as Extract<BtwResult, { type: "answer" }>).text}
                tableOptions={{ style: "grid" }}
                fg={theme.markdownText}
                bg={theme.backgroundPanel}
              />
            </scrollbox>
          )}
        </Match>
      </Switch>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="word">
          {footer()}
        </text>
        <Show when={result()}>
          <text fg={theme.textMuted}>{text().close}</text>
        </Show>
      </box>
    </box>
  )
}
