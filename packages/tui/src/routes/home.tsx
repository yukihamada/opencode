import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useToast } from "../ui/toast"
import { DialogResume } from "../component/dialog-resume"
import { Resume } from "../util/resume"

let once = false
// Ask about interrupted work at most once per process (not per visit to Home).
let resumeAsked = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

function useDynamicPlaceholder() {
  const sync = useSync()
  return createMemo(() => {
    const sessions = sync.data.session
    if (sessions.length === 0) return placeholder
    const latest = sessions.toSorted((a, b) => b.time.updated - a.time.updated)[0]
    if (!latest?.title) return placeholder
    return {
      normal: [latest.title, ...placeholder.normal],
      shell: placeholder.shell,
    }
  })
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const dynamicPlaceholder = useDynamicPlaceholder()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false
  const nav = useRoute()
  const sdk = useSDK()
  const dialog = useDialog()
  const kv = useKV()
  const toast = useToast()

  onMount(() => {
    editor.clearSelection()
  })

  // ⏸ "Pick up where we left off": when the newest session in this directory was cut
  // off (process died / timeout / error), offer a one-key resume instead of making the
  // user hunt through /sessions. Skipped when the user already chose a target (-c/-s/
  // --resume/--prompt) and remembered per session once dismissed with "Start fresh".
  createEffect(() => {
    if (resumeAsked) return
    if (!sync.ready || !local.model.ready) return
    if (args.continue || args.resume || args.sessionID || args.prompt || route.prompt) {
      resumeAsked = true
      return
    }
    const latest = Resume.latestRoot(sync.data.session)
    if (!latest || kv.get("resume_dismissed") === latest.id) {
      resumeAsked = true
      return
    }
    resumeAsked = true
    void (async () => {
      const state = await Resume.inspect(sdk, latest.id).catch(() => undefined)
      if (!state) return
      const title = latest.title?.trim() || "Untitled session"
      const choice = await DialogResume.show(
        dialog,
        "Resume interrupted work?",
        `${title} (${Resume.ago(state.at)})\n${Resume.describe(state.kind)} Press r to resume; Enter starts fresh.`,
      )
      if (choice !== "resume") {
        if (choice === "fresh") kv.set("resume_dismissed", latest.id)
        return
      }
      const model = local.model.current()
      if (!model) {
        toast.show({ variant: "warning", message: "Connect a provider to resume this session", duration: 4000 })
        return
      }
      nav.navigate({ type: "session", sessionID: latest.id })
      await Resume.send(sdk, {
        sessionID: latest.id,
        model,
        agent: local.agent.current()?.name,
        variant: local.model.variant.current(),
      }).catch((error) => {
        toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : "Failed to resume session",
          duration: 5000,
        })
      })
    })()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={dynamicPlaceholder()} />
          </pluginRuntime.Slot>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
