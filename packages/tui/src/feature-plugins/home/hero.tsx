import type { TuiPlugin, TuiPluginApi } from "@sente-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import { Logo } from "../../component/logo"

const id = "internal:home-hero"

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return "Good night"
  if (h < 11) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

function HeroLogo(props: { api: TuiPluginApi }) {
  const theme = useTheme().theme
  const version = props.api.app.version
  return (
    <box flexDirection="column" alignItems="center" gap={0}>
      <Logo />
      <text fg={theme.textMuted}>
        {greeting()} · v{version}
      </text>
    </box>
  )
}

function LatestSession(props: { api: TuiPluginApi }) {
  const theme = useTheme().theme
  const shortcut = useCommandShortcut("session.list")
  const [sessions] = createResource(
    () => props.api.state.ready,
    async (ready) => {
      if (!ready) return []
      const result = await props.api.client.session.list({ limit: 5, roots: true })
      return result.data ?? []
    },
  )
  const latest = createMemo(() => sessions()?.[0])

  return (
    <Show when={latest()}>
      {(session) => (
        <box flexDirection="column" alignItems="center" gap={0} paddingTop={1}>
          <text fg={theme.textMuted}>
            Last session: <span style={{ fg: theme.text }}>{session().title}</span>
          </text>
          <text fg={theme.textMuted}>
            {shortcut() ? (
              <>
                Press <span style={{ fg: theme.warning }}>{shortcut()}</span> to resume
              </>
            ) : (
              <>
                Use <span style={{ fg: theme.warning }}>/sessions</span> to resume
              </>
            )}
          </text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      home_logo() {
        return <HeroLogo api={api} />
      },
      home_bottom() {
        return (
          <box width="100%" maxWidth={75} alignItems="center" paddingTop={0} flexShrink={1}>
            <LatestSession api={api} />
          </box>
        )
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
