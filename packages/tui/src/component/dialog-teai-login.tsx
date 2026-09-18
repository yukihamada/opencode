import { createSignal } from "solid-js"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import {
  TEAI_KEY_ENV,
  credentialsPath,
  formatCredits,
  looksLikeKey,
  normalizeKey,
  saveCredentials,
  siteBase,
  verifyKey,
} from "../util/teai"

export type ApplyEnv = (env: Record<string, string>) => Promise<void>

/**
 * `/login` — paste a teai.io API key and switch the running session to it.
 *
 * 1. verify against /api/v1/auth/me (no key is saved unless the server accepts it)
 * 2. write `$TE_CONFIG_DIR/credentials` so the `te` launcher, `te whoami` and
 *    MCP tools agree with the engine from now on
 * 3. push the key into the engine's environment (worker RPC) and reload the
 *    instance so `{env:TEAI_API_KEY}` in the provider config resolves to it
 */
export function DialogTeaiLogin(props: { onEnv?: ApplyEnv }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const [busyText, setBusyText] = createSignal("Checking key…")
  const site = siteBase()

  async function apply(key: string) {
    process.env[TEAI_KEY_ENV] = key
    if (props.onEnv) {
      await props.onEnv({ [TEAI_KEY_ENV]: key })
      return
    }
    // Attached to a remote engine: we cannot reach its environment, so store
    // the key as provider auth and reload — the server picks it up from auth.json.
    await sdk.client.auth.set({ providerID: "teai", auth: { type: "api", key } })
    await sdk.client.instance.dispose()
  }

  return (
    <DialogPrompt
      title="Log in to teai.io"
      placeholder="te_…"
      busy={busy()}
      busyText={busyText()}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>
            Paste your teai.io API key. It is checked first, then saved to {credentialsPath()} and applied to this
            session without a restart.
          </text>
          <text fg={theme.text}>
            Get a key: <span style={{ fg: theme.primary }}>{site}/dashboard#api-keys</span>
            <span style={{ fg: theme.textMuted }}> · no account yet: run </span>
            <span style={{ fg: theme.primary }}>te register</span>
          </text>
        </box>
      )}
      onConfirm={async (value) => {
        if (busy()) return
        const key = normalizeKey(value ?? "")
        if (!key) return
        if (!looksLikeKey(key)) {
          toast.show({ variant: "warning", message: "teai.io keys start with te_ — paste the full key." })
          return
        }
        setBusy(true)
        try {
          setBusyText("Checking key with teai.io…")
          const result = await verifyKey(key)
          if (!result.ok) {
            toast.show({
              variant: "error",
              duration: 6000,
              message:
                result.reason === "invalid"
                  ? `teai.io rejected this key (${result.detail ?? "unauthorized"}). Issue a new one at ${site}/dashboard#api-keys`
                  : `Could not reach teai.io (${result.detail ?? "network"}). Check the connection and try again.`,
            })
            return
          }
          setBusyText("Saving and applying…")
          const file = await saveCredentials(key)
          await apply(key)
          await sync.bootstrap()
          const who = result.account.email ?? result.account.display_name ?? "teai.io"
          toast.show({
            variant: "success",
            duration: 6000,
            message: `Logged in as ${who} · ${formatCredits(result.account.credits_remaining)} · saved to ${file}`,
          })
          dialog.clear()
        } catch (error) {
          toast.show({
            variant: "error",
            duration: 6000,
            message: `Login failed: ${error instanceof Error ? error.message : String(error)}`,
          })
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}
