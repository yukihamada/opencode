import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import { registerOpencodeSpinner } from "../register-spinner"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { Flag } from "@sente-ai/core/flag/flag"
import { tint, useTheme } from "../../context/theme"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { promptOffsetWidth } from "../../prompt/display"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { deliverPrompt, sendFailureText, promptUnchanged } from "../../prompt/send"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { AssistantMessage, FilePart, UserMessage } from "@sente-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { formatDuration } from "../../util/format"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useLanguage } from "../../context/language"
import { useUsageMode } from "../dialog-mode"
import { invalidModeMessage, parseModeCommand } from "../../util/usage-mode"
import {
  backend as dictationBackend,
  buildLexicon,
  describeVoice,
  joinTranscript,
  parseHoldKey,
  longEnoughToSubmit,
  privacyNotice,
  summarizeVoice,
  parseVoiceCommand,
  Recording,
  sttLanguage,
  unavailableReason,
  type RecordingResult,
  type VoiceCommand,
  type VoiceSettings,
} from "../../util/dictation"
import { stopSpeaking } from "../../util/voice"
import { spendLabel, todayCost, turnCostWithSubagents } from "../../util/spend"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { useArgs } from "../../context/args"
import { formatKeySequence, SENTE_BASE_MODE, useBindings, useKeymapSelector, useCommandShortcut, useLeaderActive, useOpencodeKeymap } from "../../keymap"
import { useTuiConfig } from "../../config"
import { usePromptWorkspace } from "./workspace"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { useLocation } from "../../context/location"
import { PromptRecovery } from "./recovery"
import { ModelPresets } from "../model-presets"
import { modelBrowseText } from "../../util/model-browse"

registerOpencodeSpinner()

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const paths = useTuiPaths()
  const location = useLocation()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = useOpencodeKeymap()
  const agentShortcut = useCommandShortcut("agent.cycle")
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const renderer = useRenderer()
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const language = useLanguage()
  const usageMode = useUsageMode()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const workspace = usePromptWorkspace(props.sessionID)
  const move = usePromptMove({ projectID: project.project, sessionID: () => props.sessionID })
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
    if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      // This turn / today, in the locale's currency. The session total stays in the sidebar.
      // The turn includes subagent sessions, which record their own cost.
      cost: spendLabel({
        turn: props.sessionID
          ? turnCostWithSubagents({
              sessionID: props.sessionID,
              sessions: sync.data.session,
              messages: sync.data.message,
            })
          : undefined,
        today: todayCost({ sessions: sync.data.session, messages: sync.data.message, now: Date.now() }),
      }),
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        if (msg.model) {
          local.model.set(msg.model)
          local.model.variant.set(msg.model.variant)
        }
      }
    }
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await clipboard.read?.()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slashName: "editor",
        run: async () => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
              project.instance.directory() ||
              paths.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = normalized.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: normalized,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(normalized)
        },
      },
      {
        title: "Open image attachment",
        desc: "Open the prompt's image attachment in the system viewer",
        name: "prompt.image.open",
        category: "Prompt",
        slashName: "image",
        enabled: store.prompt.parts.some((x) => x.type === "file" && x.mime.startsWith("image/")),
        run: async () => {
          dialog.clear()
          const images = store.prompt.parts.filter(
            (x): x is Extract<typeof x, { type: "file" }> => x.type === "file" && x.mime.startsWith("image/"),
          )
          if (images.length === 0) return
          const part = images[images.length - 1]
          const match = /^data:([^;]+);base64,(.+)$/s.exec(part.url)
          if (!match) {
            toast.show({ variant: "error", message: "Image data is not embedded; cannot open", duration: 4000 })
            return
          }
          const { writeFile } = await import("node:fs/promises")
          const { tmpdir } = await import("node:os")
          const { default: openExternal } = await import("open")
          const ext = match[1].split("/")[1]?.replace("svg+xml", "svg") ?? "png"
          const file = path.join(tmpdir(), `sente-image-${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`)
          await writeFile(file, Buffer.from(match[2], "base64"))
          await openExternal(file)
          toast.show({ variant: "info", message: `Opened ${part.filename ?? file}`, duration: 3000 })
        },
      },
      {
        title: language.text("スキル", "Skills"),
        name: "prompt.skills",
        category: "Prompt",
        slashName: "skills",
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Warp",
        desc: "Change the workspace for the session",
        name: "workspace.set",
        category: "Session",
        enabled: Flag.SENTE_EXPERIMENTAL_WORKSPACES,
        slashName: "warp",
        run: () => {
          workspace.open()
        },
      },
      {
        title: "Move session",
        desc: "Move to another project dir",
        name: "session.move",
        category: "Session",
        slashName: "move",
        run: () => {
          move.open()
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    mode: SENTE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "workspace.set",
      "session.move",
    ]),
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      setStore("mode", prompt.mode ?? "normal")
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      setStore("mode", saved.prompt.mode ?? "normal")
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: structuredClone(unwrap({ ...store.prompt, mode: store.mode })), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
            mode: store.mode,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            if (store.prompt.input || store.prompt.parts.length) {
              stash.push({ ...store.prompt, mode: store.mode })
            }
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            setStore("mode", entry.mode ?? "normal")
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                if (store.prompt.input || store.prompt.parts.length) {
                  stash.push({ ...store.prompt, mode: store.mode })
                }
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                setStore("mode", entry.mode ?? "normal")
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  // 音声入力(Claude Code の voice dictation と同じ操作)。録音と文字起こしは TUI の中だけで
  // 行い、セッションやモデルには何も送らない。
  // - 長押し(既定): 空欄で Space を押し続けて話し、離すと入力欄に入る。
  //   kitty 対応端末は離した瞬間を、それ以外はキーリピートが止まった瞬間を「離した」とみなす。
  //   話し始めを落とさないよう、最初の Space で裏で録音を始め、ただの空白だったら送らずに捨てる。
  // - タップ: 空欄で Space を1回押して話し、もう1回押すと送信(3語以上・日本語は長さ不問)。
  // - Ctrl+Space / <leader>v(変更可)と `/v` は、どちらのモードでも開始・確定に使える。
  // - 録音中の Esc / Ctrl+C は取消だけに使う(作業の中断や終了には渡さない)。
  // 日本語入力 ON の Space(全角空白)も Space として扱う。
  const voiceSettings = createMemo((): VoiceSettings => {
    const config = tuiConfig.voice ?? {}
    const saved = (kv.get("voice_input", {}) ?? {}) as Partial<VoiceSettings>
    return {
      enabled: saved.enabled ?? config.enabled ?? process.platform === "darwin",
      mode: saved.mode ?? config.mode ?? "hold",
      autoSubmit: saved.autoSubmit ?? config.auto_submit ?? config.autoSubmit ?? false,
      language: config.language,
    }
  })
  // 割り当てを全部見せる(macOS は Ctrl+Space が入力ソース切替に取られていることが多い)。
  const voiceBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: ["prompt.voice"] }).get("prompt.voice"),
  )
  const voiceKeyLabel = () =>
    (voiceBindings() ?? [])
      .map((binding) => formatKeySequence(binding.sequence, tuiConfig))
      .filter(Boolean)
      .join(english() ? " or " : " か ") || "Ctrl+Space"
  const voiceConsented = () => kv.get("voice_input_consent", false) === true
  type VoiceSource = "hold" | "tap" | "toggle"
  const [voiceUi, setVoiceUi] = createSignal<
    { phase: "recording" | "transcribing"; source: VoiceSource; level: number; elapsed: number; partial?: string } | undefined
  >()
  const VOICE_KITTY_HOLD_MS = 200
  // キーリピートが始まるまでの待ち時間。macOS の設定(リピート入力認識までの時間)+余裕。読めなければ 650ms。
  const voiceDoubleTapMs = () => Math.min(300, Math.max(60, (dictationBackend.keyRepeatDelayMs() ?? 400) * 0.8))
  const voiceRepeatWait = () => Math.min(2500, Math.max(650, (dictationBackend.keyRepeatDelayMs() ?? 400) + 250))
  let voiceRecording: Recording | undefined
  let voiceSource: VoiceSource | undefined
  let voiceConfirmed = false
  let voiceSilentCancel = false
  let voiceFinishSubmit: boolean | undefined
  let voicePending: { kitty: boolean; char: string; timer: ReturnType<typeof setTimeout> } | undefined
  let voiceSwallow: { kitty: boolean } | undefined
  let voiceLastSpace = 0
  let voiceRepeatGap = 0
  let voiceReleaseTimer: ReturnType<typeof setInterval> | undefined
  let voiceDisposed = false

  function english() {
    return language.current() !== "ja"
  }

  function voiceCanToggle() {
    return (
      !!input &&
      !input.isDestroyed &&
      props.visible !== false &&
      !props.disabled &&
      dialog.stack.length === 0 &&
      store.mode === "normal" &&
      !auto()?.visible
    )
  }

  function voiceCanStart() {
    return (
      voiceCanToggle() &&
      input.focused &&
      !leader() &&
      // Space 以外の長押しキーなら、入力欄に文字があっても始められる。
      (!!voiceHoldKey() || (store.prompt.input.trim() === "" && store.prompt.parts.length === 0))
    )
  }

  const voiceHoldKey = createMemo(() => parseHoldKey(tuiConfig.voice?.hold_key))
  // 長押しキーなら、押した時に入る文字(Space は空白、ほかのキーは何も入れない)。違うキーなら undefined。
  // loose=true(長押しの最中・離した時)はキー名だけで判定する。修飾キーを先に離しても止まるように。
  function holdChar(event: KeyEvent, loose = false) {
    const key = voiceHoldKey()
    if (!key) return spaceChar(event)
    if (loose && event.name === key.name) return ""
    const match =
      event.name === key.name &&
      !!event.ctrl === key.ctrl &&
      !!event.meta === key.meta &&
      !!event.shift === key.shift &&
      !!event.option === key.option
    return match ? "" : undefined
  }

  function spaceChar(event: KeyEvent) {
    if (event.name === "space" || event.name === " " || event.sequence === " ") return " "
    if (event.name === "　" || event.sequence === "　") return "　"
    return undefined
  }

  // 録音を始める。visible=false は長押し判定前の先行録音(画面に出さず、外れたら捨てる)。
  function startVoice(source: VoiceSource, visible = true) {
    if (voiceRecording) return false
    // 初回は送信先を説明して同意を取るまで、マイクを一切開かない。
    if (!voiceConsented()) {
      if (visible) askVoiceConsent(source)
      return false
    }
    const reason = unavailableReason(english(), process.env, process.platform, undefined, tuiConfig.voice?.device)
    if (reason) {
      if (visible) toast.show({ title: "🎤", message: reason, variant: "error", duration: 8000 })
      return false
    }
    const recorder = dictationBackend.findRecorder(undefined, tuiConfig.voice?.device)
    if (!recorder) return false
    const directory = project.instance.path().worktree || project.instance.path().directory || process.cwd()
    const recording = new Recording({
      recorder,
      english: english(),
      language: sttLanguage(voiceSettings().language) ?? sttLanguage(language.current()),
      lexicon: buildLexicon({ directory, branch: dictationBackend.gitBranch(directory) }),
      onLevel: (level, elapsed) => {
        const ui = voiceUi()
        if (ui?.phase === "recording") setVoiceUi({ ...ui, level, elapsed })
      },
      onTranscribing: () => {
        const ui = voiceUi()
        if (ui) setVoiceUi({ ...ui, phase: "transcribing" })
      },
      onPartial: (partial) => {
        const ui = voiceUi()
        if (ui) setVoiceUi({ ...ui, partial })
      },
      onAutoStop: () => {
        clearInterval(voiceReleaseTimer)
        voiceReleaseTimer = undefined
        // 長押しのまま自動停止した時、押し続けている Space を入力欄へ漏らさない。
        if (voiceSource === "hold") voiceSwallow = { kitty: voiceLastKitty }
      },
    })
    voiceRecording = recording
    voiceSource = source
    voiceConfirmed = false
    voiceSilentCancel = false
    voiceFinishSubmit = undefined
    void recording.result.then((result) => onVoiceResult(recording, result))
    if (visible) confirmVoice()
    return true
  }
  let voiceLastKitty = false

  function confirmVoice() {
    if (!voiceRecording || voiceConfirmed) return
    voiceConfirmed = true
    // Sente の声(KOE)が読み上げ中なら止める。自分の声だけを拾うため。
    if (process.env.NODE_ENV !== "test") stopSpeaking()
    setVoiceUi({ phase: "recording", source: voiceSource ?? "toggle", level: 0, elapsed: 0 })
  }

  let voiceAsking = false
  function askVoiceConsent(source: VoiceSource) {
    if (voiceAsking) return
    voiceAsking = true
    const text = (ja: string, en: string) => (english() ? en : ja)
    // 長押し中に開いた時、押し続けている Space をダイアログへ渡さない。
    if (source === "hold") voiceSwallow = { kitty: voiceLastKitty }
    void DialogConfirm.show(
      dialog,
      text("音声入力を使いますか", "Use voice input?"),
      privacyNotice(english()) +
        text(
          "\n\n長押しを見分けるため、空欄で Space を押した瞬間からマイクを開きます(ただの空白なら送らずに捨てます)。Enter で使い始めます。",
          "\n\nTo detect a hold, the microphone opens as soon as you press Space on an empty prompt (a plain space is discarded, never sent). Press Enter to enable.",
        ),
      // DialogConfirm の label は「やめる」側のボタン名。
      text("使わない", "Not now"),
    ).then((ok) => {
      voiceAsking = false
      if (voiceDisposed) return
      if (ok) {
        kv.set("voice_input_consent", true)
        kv.set("voice_input", { ...((kv.get("voice_input", {}) ?? {}) as object), enabled: true })
        if (source === "hold" || source === "tap") {
          toast.show({
            title: "🎤",
            message:
              source === "hold"
                ? text("使えるようになりました。Space を長押しして話してください", "Ready. Hold Space and speak")
                : text("使えるようになりました。Space を押して話してください", "Ready. Tap Space and speak"),
            variant: "info",
            duration: 4000,
          })
          return
        }
        setTimeout(() => startVoice(source), 0)
        return
      }
      kv.set("voice_input", { ...((kv.get("voice_input", {}) ?? {}) as object), enabled: false })
      toast.show({ title: "🎤", message: text("音声入力はオフのままです(/v on で使えます)", "Voice input stays off (/v on to enable)"), variant: "info", duration: 4000 })
    })
  }

  // 録音を入力欄に戻せない時(入力欄が閉じた・ダイアログが開いた)、文字にして下書き(stash)へ退避する。
  function stashVoice() {
    const recording = voiceRecording
    if (!recording) return
    voiceRecording = undefined
    voiceSource = undefined
    voiceConfirmed = false
    voiceFinishSubmit = undefined
    clearInterval(voiceReleaseTimer)
    voiceReleaseTimer = undefined
    if (!voiceDisposed) setVoiceUi(undefined)
    const text = (ja: string, en: string) => (english() ? en : ja)
    void recording.finish().then((result) => {
      if (result.type === "cancelled" || result.type === "empty") return
      if (result.type === "error") {
        toast.show({
          title: "🎤",
          message: text(`話した内容を文字にできませんでした: ${result.message}`, `Your dictation could not be transcribed: ${result.message}`),
          variant: "error",
          duration: 10000,
        })
        return
      }
      stash.push({ input: result.text, parts: [], mode: "normal" })
      toast.show({
        title: "🎤",
        message: text(
          `話した内容を下書きに退避しました: ${result.text.slice(0, 40)}(コマンド一覧の Stash list から戻せます)`,
          `Your dictation was stashed: ${result.text.slice(0, 40)} (restore from Stash list in the command palette)`,
        ),
        variant: "info",
        duration: 10000,
      })
    })
  }

  function finishVoice(tailMs: number, submitAfter?: boolean) {
    const recording = voiceRecording
    if (!recording) return
    clearInterval(voiceReleaseTimer)
    voiceReleaseTimer = undefined
    if (submitAfter !== undefined) voiceFinishSubmit = submitAfter
    void recording.finish(tailMs)
  }

  function cancelVoice(silent = false) {
    const recording = voiceRecording
    if (!recording) return
    clearInterval(voiceReleaseTimer)
    voiceReleaseTimer = undefined
    voiceSilentCancel = silent
    recording.cancel()
  }

  function onVoiceResult(recording: Recording, result: RecordingResult) {
    if (voiceRecording !== recording) return
    const source = voiceSource
    const submitAfter = voiceFinishSubmit
    const silent = voiceSilentCancel || !voiceConfirmed
    voiceRecording = undefined
    voiceSource = undefined
    voiceConfirmed = false
    voiceFinishSubmit = undefined
    voiceSilentCancel = false
    setVoiceUi(undefined)
    if (voiceDisposed) return
    const text = (ja: string, en: string) => (english() ? en : ja)
    if (result.type === "cancelled") {
      if (!silent)
        toast.show({ title: "🎤", message: text("音声入力を取り消しました", "Voice input cancelled"), variant: "info", duration: 2000 })
      return
    }
    if (silent) return
    if (result.type === "error") {
      toast.show({ title: "🎤", message: result.message, variant: "error", duration: 8000 })
      return
    }
    if (result.type === "empty") {
      toast.show({ title: "🎤", message: text("聞き取れませんでした。もう一度どうぞ", "Didn't catch that. Try again"), variant: "info", duration: 3000 })
      return
    }
    if (!input || input.isDestroyed) return
    if (result.warning) toast.show({ title: "🎤", message: result.warning, variant: "warning", duration: 8000 })
    input.insertText(joinTranscript(input.plainText.slice(0, input.cursorOffset), result.text))
    const send =
      submitAfter ??
      (source === "tap" ? longEnoughToSubmit(result.text) : voiceSettings().autoSubmit && longEnoughToSubmit(result.text))
    // シェルモード等では自動送信しない(話した言葉がコマンドとして走らないように)。
    if (send && store.mode === "normal") setTimeout(() => setTimeout(() => void submit(), 0), 0)
  }

  // 長押し判定の結果「ただの Space」だった: 先行録音を捨て、空白を入れる。
  function resolvePendingAsTap() {
    const pending = voicePending
    if (!pending) return
    clearTimeout(pending.timer)
    voicePending = undefined
    if (voiceRecording && !voiceConfirmed) cancelVoice(true)
    if (pending.char && input && !input.isDestroyed) input.insertText(pending.char)
  }

  // キーリピートが途切れたら「離した」とみなす(kitty 以外の端末の長押し)。
  function watchRepeatRelease() {
    clearInterval(voiceReleaseTimer)
    voiceReleaseTimer = setInterval(() => {
      const gap = Math.min(1500, Math.max(300, voiceRepeatGap * 3))
      if (Date.now() - voiceLastSpace > gap) finishVoice(0)
    }, 50)
  }

  function consume(event: KeyEvent) {
    event.preventDefault()
    event.stopPropagation()
  }

  function onVoiceKey(event: KeyEvent) {
    const char = holdChar(
      event,
      event.eventType === "release" || !!voicePending || !!voiceSwallow || (!!voiceRecording && voiceSource === "hold"),
    )
    const space = char !== undefined
    const noMods = !event.ctrl && !event.meta && !event.option && !event.shift && !event.super && !event.hyper
    // 修飾キー付きの長押しキーは、修飾キーごと一致した時点で「素の押下」とみなす。
    const plain = voiceHoldKey() ? space : noMods
    const release = event.eventType === "release"
    const repeat = event.eventType === "repeat"
    const now = Date.now()

    // 長押しが自動停止した後、まだ押されている Space を捨てる。
    if (voiceSwallow) {
      const over = voiceSwallow.kitty ? release && space : !space || now - voiceLastSpace > 400
      if (over) {
        voiceSwallow = undefined
        if (release && space) return consume(event)
      } else if (space) {
        voiceLastSpace = now
        return consume(event)
      }
    }

    // ダイアログが開いたらキーはそちらへ。録音中なら、話した内容を下書きへ退避する。
    if (dialog.stack.length > 0) {
      if (voicePending) {
        clearTimeout(voicePending.timer)
        voicePending = undefined
      }
      if (voiceRecording && voiceConfirmed) stashVoice()
      else if (voiceRecording) cancelVoice(true)
      return
    }

    // 録音中・文字起こし中
    if (voiceRecording && voiceConfirmed) {
      if (release) {
        if (space && voiceSource === "hold") {
          consume(event)
          finishVoice(250)
        }
        return
      }
      if (event.name === "escape" || (event.ctrl && event.name === "c")) {
        consume(event)
        cancelVoice()
        return
      }
      if (event.name === "return" && noMods) {
        consume(event)
        // 文字起こし中に押した Enter も「入ったら送信」として受け付ける。
        if (voiceUi()?.phase === "recording") finishVoice(150, true)
        else voiceFinishSubmit = true
        return
      }
      if (!space) return
      consume(event)
      const gap = now - voiceLastSpace
      voiceLastSpace = now
      if (voiceSource === "hold") {
        voiceRepeatGap = voiceRepeatGap ? (voiceRepeatGap + gap) / 2 : gap
        return
      }
      // タップ・トグル: キーリピート(押し続け)は2回目の押下とみなさない。
      if (voiceUi()?.phase !== "recording" || repeat || gap < 200) return
      finishVoice(150, voiceSource === "tap" ? undefined : voiceSettings().autoSubmit ? undefined : false)
      return
    }

    // 長押しの判定待ち
    if (voicePending) {
      if (release) {
        if (!space) return
        consume(event)
        resolvePendingAsTap()
        return
      }
      if (space && plain) {
        consume(event)
        if (voicePending.kitty) return
        // キーリピートは「リピート開始までの時間」より前には来ない。それより速い2回目は素早い2連打。
        if (now - voiceLastSpace < voiceDoubleTapMs()) {
          resolvePendingAsTap()
          if (char && input && !input.isDestroyed) input.insertText(char)
          return
        }
        // kitty 以外: 2回目のスペース(=キーリピート)が来たら長押し。
        clearTimeout(voicePending.timer)
        voicePending = undefined
        voiceLastSpace = now
        voiceRepeatGap = 0
        if (voiceRecording) confirmVoice()
        else startVoice("hold")
        if (voiceRecording) watchRepeatRelease()
        return
      }
      // 別のキー: 待っていたスペースを先に入れてから、そのキーを通す。
      resolvePendingAsTap()
      return
    }

    if (release || !space || !plain || !voiceSettings().enabled || !voiceCanStart()) return
    consume(event)
    if (repeat) return
    voiceLastSpace = now
    if (voiceSettings().mode === "tap") {
      startVoice("tap")
      return
    }
    // 日本語入力の全角空白は、離した合図が来ない端末があるため常にキーリピートで判定する。
    const kitty = event.source === "kitty" && char !== "\u3000"
    voiceLastKitty = kitty
    startVoice("hold", false)
    voicePending = {
      kitty,
      char,
      timer: setTimeout(
        () => {
          if (!kitty) return resolvePendingAsTap()
          voicePending = undefined
          if (!voiceCanStart()) return cancelVoice(true)
          if (voiceRecording) confirmVoice()
          else startVoice("hold")
        },
        kitty ? VOICE_KITTY_HOLD_MS : voiceRepeatWait(),
      ),
    }
  }

  function toggleVoice() {
    if (voiceRecording && voiceConfirmed) {
      if (voiceUi()?.phase === "recording") finishVoice(150, voiceSettings().autoSubmit ? undefined : false)
      return
    }
    if (voicePending) return
    if (voiceCanToggle()) startVoice("toggle")
  }

  useBindings(() => ({
    target: inputTarget,
    enabled: inputTarget() !== undefined && !props.disabled,
    commands: [
      {
        name: "prompt.voice",
        title: language.text("音声入力の開始・確定", "Start or finish voice input"),
        category: "Prompt",
        run: toggleVoice,
      },
    ],
    bindings: tuiConfig.keybinds.get("prompt.voice"),
  }))

  // `/v` を入力候補から選んだ時も、サーバーへ送らずここで録音を始める。
  useBindings(() => ({
    enabled: !props.disabled && props.visible !== false,
    commands: [
      {
        name: "prompt.voice.slash",
        namespace: "palette",
        title: language.text("音声入力(/v hold・tap・on・off・auto・status)", "Voice input (/v hold, tap, on, off, auto, status)"),
        category: "Prompt",
        slashName: "v",
        run: () => setTimeout(toggleVoice, 0),
      },
    ],
  }))

  function handleVoiceCommand(command: VoiceCommand) {
    const text = (ja: string, en: string) => (english() ? en : ja)
    if (command.type === "invalid") {
      toast.show({
        title: "🎤",
        message: text(
          `「${command.value}」は分かりませんでした。使えるのは /v・/v hold・/v tap・/v on・/v off・/v auto on|off・/v status です`,
          `Unknown option "${command.value}". Use /v, /v hold, /v tap, /v on, /v off, /v auto on|off, /v status`,
        ),
        variant: "error",
        duration: 8000,
      })
      return
    }
    if (command.type === "stop") {
      cancelVoice()
      return
    }
    if (command.type === "status") {
      void DialogAlert.show(dialog, text("音声入力", "Voice input"), describeVoice(voiceSettings(), english(), voiceKeyLabel(), voiceHoldKey()))
      return
    }
    if (command.type === "set") {
      // 旧版の `/v off` は「録音を止める」だった。録音中ならその意味で扱い、設定は変えない。
      if (command.settings.enabled === false && voiceRecording) {
        cancelVoice()
        return
      }
      kv.set("voice_input", { ...((kv.get("voice_input", {}) ?? {}) as object), ...command.settings })
      const reason = command.settings.enabled ? unavailableReason(english(), process.env, process.platform, undefined, tuiConfig.voice?.device) : undefined
      toast.show({
        title: "🎤",
        message: reason ?? summarizeVoice(voiceSettings(), english()),
        variant: reason ? "error" : "info",
        duration: reason ? 8000 : 3000,
      })
      return
    }
    // `/v` は入力欄を空にしてから録音を始める(終わり方は Ctrl+Space と同じ)。
    setTimeout(toggleVoice, 0)
  }

  onMount(() => {
    // 本体のキー割り当て(Ctrl+C で終了・Esc で中断など)より先に受け取り、使ったキーはそこで止める。
    const offPress = keymap.intercept("key", ({ event }) => onVoiceKey(event), { priority: 1000 })
    const offRelease = keymap.intercept("key", ({ event }) => onVoiceKey(event), { priority: 1000, release: true })
    onCleanup(() => {
      voiceDisposed = true
      if (voicePending) clearTimeout(voicePending.timer)
      voicePending = undefined
      // 権限確認などで入力欄が画面から外れた時、話していた内容を捨てずに下書きへ退避する。
      if (voiceRecording && voiceConfirmed) stashVoice()
      else cancelVoice(true)
      offPress()
      offRelease()
    })
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  const presetArrows = () =>
    inputTarget() !== undefined && !props.disabled && props.visible !== false &&
    dialog.stack.length === 0 && store.mode === "normal" && !auto()?.visible &&
    local.model.presets().length > 0 && store.prompt.parts.length === 0

  useBindings(() => ({
    target: inputTarget,
    enabled: presetArrows() && store.prompt.input === "",
    bindings: [
      { key: "left", desc: modelBrowseText().previous, group: "Prompt", cmd: () => local.model.cyclePreset(-1) },
      { key: "right", desc: modelBrowseText().next, group: "Prompt", cmd: () => local.model.cyclePreset(1) },
    ],
  }))

  useBindings(() => ({
    target: inputTarget,
    enabled: presetArrows() && store.prompt.input !== "",
    bindings: [
      { key: "right", desc: modelBrowseText().next, group: "Prompt", cmd: () => local.model.cyclePreset(1) },
    ],
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) input.cursorOffset = 0
              return false
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              )
                input.cursorOffset = input.plainText.length
              return false
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  let submitting = false
  async function submit() {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.input`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner()
    } catch (error) {
      move.finishSubmit()
      const text = sendFailureText()
      toast.show({
        title: text.title,
        message: `${errorMessage(error)}\n${text.retained}`,
        variant: "error",
      })
      return false
    } finally {
      submitting = false
    }
  }

  async function submitInner() {
    workspace.clearNotice()

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (workspace.creating() || move.creating()) return false
    if (auto()?.visible) return false
    if (!store.prompt.input.trim()) return false
    const agent = local.agent.current()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    // `/mode 節約` 等はサーバのコマンドではなく手元で設定を切り替える(引数なしはダイアログと同じ表示)。
    const modeCommand = parseModeCommand(trimmed)
    if (modeCommand) {
      if (modeCommand.type === "set") void usageMode.set(modeCommand.mode)
      if (modeCommand.type === "show") usageMode.showStatus()
      if (modeCommand.type === "invalid")
        toast.show({ variant: "error", message: invalidModeMessage(modeCommand.value, language.current()) })
      history.append(structuredClone(unwrap({ ...store.prompt, mode: store.mode })))
      input.extmarks.clear()
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      return true
    }
    // `/v` 系(音声入力)もサーバーへ送らず手元で処理する。
    const voiceCommand = parseVoiceCommand(trimmed)
    if (voiceCommand) {
      input.extmarks.clear()
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      handleVoiceCommand(voiceCommand)
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            workspace.open()
            return false
          }}
        />
      ))
      return false
    }

    const variant = local.model.variant.current()
    // Capture before session/workspace creation yields to further typing.
    const prompt = structuredClone(unwrap({ ...store.prompt, mode: store.mode }))
    const inputText = expandTrackedPastedText(
      prompt.input,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const partIndex = store.extmarkToPartIndex.get(extmark.id)
        const part = partIndex === undefined ? undefined : prompt.parts[partIndex]
        if (part?.type !== "text") return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )
    let sessionID = props.sessionID
    let finishMoveProgress = false
    if (sessionID == null) {
      const selectedWorkspace = workspace.selection()
      const workspaceID = selectedWorkspace?.type === "existing" ? selectedWorkspace.workspaceID : undefined

      const directory = await move.getDirectory(prompt.input)
      if (move.pending() && !directory) return false
      finishMoveProgress = Boolean(move.progress())

      const res = await sdk.client.session.create({
        directory,
        workspace: workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant,
        },
      })

      if (res.error) {
        throw res.error
      }

      sessionID = res.data.id
    }

    const editorSelection = editorContext()
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    move.startSubmit()
    void deliverPrompt(
      sdk.client,
      {
        sessionID,
        prompt,
        text: inputText,
        agent: agent.name,
        model: selectedModel,
        variant,
        commands: sync.data.command.map((command) => command.name),
        editorParts,
      },
      stash,
    ).then((result) => {
      if (result.sent) {
        if (result.editorSent && editorContext() === editorSelection) editor.markSelectionSent()
        return
      }
      const text = sendFailureText()
      toast.show({
        title: text.title,
        message: `${errorMessage(result.error)}\n${text.saved}`,
        variant: "error",
        duration: 10000,
      })
    })
    history.append(prompt)
    if (
      !input.isDestroyed &&
      promptUnchanged(prompt, { input: input.plainText, parts: store.prompt.parts, mode: store.mode })
    ) {
      input.extmarks.clear()
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      setStore("mode", "normal")
    }
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") {
        await pasteAttachment({
          filename,
          filepath,
          mime: attachment.mime,
          content: Buffer.from(attachment.content).toString("base64"),
        })
        return
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS || store.prompt.parts.length > 0) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command… "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything… "${list()[store.placeholder % list().length]}"`
  })

  const spinnerDef = createMemo(() => {
    const agent =
      status().type !== "idle"
        ? (local.agent.list().find((a) => a.name === lastUserMessage()?.agent) ?? local.agent.current())
        : local.agent.current()
    const color = agent ? local.agent.color(agent.name) : theme.border
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))
  const moveLabelWidth = createMemo(() => Math.max(12, Math.min(44, dimensions().width - 48)))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <PromptRecovery
          sessionID={props.sessionID}
          enabled={props.visible !== false && !props.disabled}
          current={() => ({ input: input.plainText, parts: store.prompt.parts, mode: store.mode })}
          onRestore={(prompt) => {
            ref.set(prompt)
            input.focus()
          }}
        />
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={maxHeight()}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                  if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : theme.text}
              cursorStyle={tuiConfig.cursor}
              syntaxStyle={syntax()}
            />
            <Show when={voiceUi()}>
              {(ui) => {
                const meter = () => {
                  const bars = "▁▂▃▄▅▆▇█"
                  return bars[Math.max(0, Math.min(bars.length - 1, Math.round(ui().level * (bars.length - 1))))]
                }
                const clock = () => {
                  const seconds = Math.floor(ui().elapsed / 1000)
                  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                }
                const hint = () => {
                  const t = (ja: string, en: string) => (english() ? en : ja)
                  if (ui().source === "hold") return t("離すと確定 · Esc で取消", "release to insert · Esc to cancel")
                  const key = voiceHoldKey()?.label ?? "Space"
                  if (ui().source === "tap") return t(`${key} で送信 · Esc で取消`, `${key} to send · Esc to cancel`)
                  return t(`${voiceKeyLabel()} か Space で確定 · Enter で送信 · Esc で取消`, `${voiceKeyLabel()} or Space to finish · Enter to send · Esc to cancel`)
                }
                // 録音中に先に文字になった分。長い時は末尾だけ見せる。
                const partial = () => {
                  const text = ui().partial ?? ""
                  return text.length > 60 ? "…" + text.slice(-60) : text
                }
                return (
                  <>
                    <Show
                      when={ui().phase === "recording"}
                      fallback={<text fg={theme.textMuted}>{english() ? "🎤 Transcribing…" : "🎤 文字起こし中…"}</text>}
                    >
                      <text>
                        <span style={{ fg: theme.error, bold: true }}>●</span>
                        <span style={{ fg: theme.text }}>{english() ? " Listening " : " 録音中 "}</span>
                        <span style={{ fg: theme.textMuted }}>{clock()} </span>
                        <span style={{ fg: theme.success }}>{meter()}</span>
                        <span style={{ fg: theme.textMuted }}> {hint()}</span>
                      </text>
                    </Show>
                    <Show when={partial()}>
                      <text fg={theme.textMuted}>{partial()}</text>
                    </Show>
                  </>
                )
              }}
            </Show>
            <Show when={store.mode === "normal" && props.visible !== false}>
              <ModelPresets
                disabled={props.disabled}
                typing={store.prompt.input !== "" || store.prompt.parts.length > 0}
                onSelect={() => input.focus()}
              />
            </Show>
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}
                      </text>
                      <Show when={store.mode === "normal" && local.permission.mode === "auto"}>
                        <text fg={fadeColor(theme.textMuted, agentMetaAlpha())}>auto</text>
                      </Show>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(leader() ? theme.textMuted : theme.text, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                            <text>
                              <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Switch>
            <Match when={status().type !== "idle"}>
              <box
                flexDirection="row"
                gap={1}
                flexGrow={1}
                justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
              >
                <box flexShrink={0} flexDirection="row" gap={1}>
                  <box marginLeft={1}>
                    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    {(() => {
                      const retry = createMemo(() => {
                        const s = status()
                        if (s.type !== "retry") return
                        return s
                      })
                      const message = createMemo(() => {
                        const r = retry()
                        if (!r) return
                        if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                          return "gemini is way too hot right now"
                        if (r.message.length > 80) return r.message.slice(0, 80) + "…"
                        return r.message
                      })
                      const isTruncated = createMemo(() => {
                        const r = retry()
                        if (!r) return false
                        return r.message.length > 120
                      })
                      const [seconds, setSeconds] = createSignal(0)
                      onMount(() => {
                        const timer = setInterval(() => {
                          const next = retry()?.next
                          if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                        }, 1000)

                        onCleanup(() => {
                          clearInterval(timer)
                        })
                      })
                      const handleMessageClick = () => {
                        const r = retry()
                        if (!r) return
                        if (isTruncated()) {
                          void DialogAlert.show(dialog, "Retry Error", r.message)
                        }
                      }

                      const retryText = () => {
                        const r = retry()
                        if (!r) return ""
                        const baseMessage = message()
                        const truncatedHint = isTruncated() ? " (click to expand)" : ""
                        const duration = formatDuration(seconds())
                        const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                        return baseMessage + truncatedHint + retryInfo
                      }

                      return (
                        <Show when={retry()}>
                          <box onMouseUp={handleMessageClick}>
                            <text fg={theme.error}>{retryText()}</text>
                          </box>
                        </Show>
                      )
                    })()}
                  </box>
                </box>
                <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                  esc{" "}
                  <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                  </span>
                </text>
              </box>
            </Match>
            <Match when={workspace.notice()}>
              {(notice) => (
                <box paddingLeft={3}>
                  <text fg={theme.accent}>{notice()}</text>
                </box>
              )}
            </Match>
            <Match when={workspace.label()}>
              {(label) => (
                <box paddingLeft={3} flexDirection="row" gap={1}>
                  <Show when={workspace.creating()}>
                    <Spinner color={theme.accent} />
                  </Show>
                  <text fg={workspace.creating() ? theme.accent : theme.text}>
                    {(() => {
                      const item = label()
                      if (item.type === "new") {
                        if (workspace.creating())
                          return `Creating ${item.workspaceType}${".".repeat(workspace.creatingDots())}`
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                          </>
                        )
                      }
                      return (
                        <>
                          Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                        </>
                      )
                    })()}
                  </text>
                </box>
              )}
            </Match>
            <Match when={move.progress()}>
              {(progress) => (
                <box paddingLeft={3}>
                  <Spinner color={theme.accent}>
                    {progress()}
                    <span style={{ fg: theme.textMuted }}>{".".repeat(move.creatingDots())}</span>
                  </Spinner>
                </box>
              )}
            </Match>
            <Match when={move.pendingNew()}>
              <box paddingLeft={3}>
                <text fg={theme.accent}>(new working copy)</text>
              </box>
            </Match>
            <Match when={true}>
              {props.hint ?? (
                <Show when={props.sessionID} fallback={<text />}>
                  <box marginLeft={1}>
                    <text fg={theme.textMuted}>{location()?.directory ?? paths.cwd}</text>
                  </box>
                </Show>
              )}
            </Match>
          </Switch>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row">
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted}>{file()}</text>
                )}
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[item().context, item().cost].filter(Boolean).join(" · ")}
                        </text>
                      )}
                    </Match>
                    <Match when={true}>
                      <text fg={theme.text}>
                        {agentShortcut()} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>
                  <text fg={theme.text}>
                    {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
