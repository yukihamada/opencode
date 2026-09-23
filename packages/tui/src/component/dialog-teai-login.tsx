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
  accountText,
  durableKey,
  formatCredits,
  looksLikeEmail,
  looksLikeKey,
  normalizeCode,
  normalizeKey,
  requestEmailCode,
  saveCredentials,
  siteBase,
  verifyEmailCode,
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

  async function finishWithKey(key: string, who: string, credits?: number) {
    const file = await saveCredentials(key)
    await apply(key)
    await sync.bootstrap()
    toast.show({
      variant: "success",
      duration: 6000,
      message: `Logged in as ${who} · ${formatCredits(credits)} · saved to ${file}`,
    })
    dialog.clear()
  }

  function fail(prefix: string, error: unknown) {
    toast.show({
      variant: "error",
      duration: 6000,
      message: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  function openEmailCodePrompt(email: string) {
    dialog.replace(() => (
      <DialogPrompt
        title="Check your email"
        placeholder="6-digit code"
        busy={busy()}
        busyText="Verifying code…"
        description={() => (
          <box gap={1}>
            <text fg={theme.textMuted}>
              We sent a 6-digit login code to <span style={{ fg: theme.text }}>{email}</span>. Paste it here to log
              in — no API key needed. The code expires in 10 minutes.
            </text>
          </box>
        )}
        onConfirm={async (value) => {
          if (busy()) return
          const code = normalizeCode(value ?? "")
          if (code.length !== 6) {
            toast.show({ variant: "warning", message: "The code is 6 digits — check the email and try again." })
            return
          }
          setBusy(true)
          try {
            const result = await verifyEmailCode(email, code)
            if (!result.ok) {
              toast.show({
                variant: "error",
                duration: 6000,
                message:
                  result.reason === "invalid"
                    ? `Code rejected (${result.detail ?? "invalid"}). Request a new one with /login.`
                    : `Could not reach teai.io (${result.detail ?? "network"}). Try again.`,
              })
              return
            }
            const key = await durableKey(result)
            const verified = await verifyKey(key)
            if (!verified.ok) {
              toast.show({
                variant: "error",
                duration: 6000,
                message: accountText().verifyFailed,
              })
              return
            }
            await finishWithKey(key, verified.account.email ?? email, verified.account.credits_remaining)
          } catch (error) {
            fail("Login failed", error)
          } finally {
            setBusy(false)
          }
        }}
      />
    ))
  }

  return (
    <DialogPrompt
      title="Log in to teai.io"
      placeholder="te_… or you@example.com"
      busy={busy()}
      busyText={busyText()}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>
            Paste your teai.io API key — or type your email address and we'll email you a 6-digit login code (no key
            needed). Either way it is saved to {credentialsPath()} and applied to this session without a restart.
          </text>
          <text fg={theme.text}>
            Get a key: <span style={{ fg: theme.primary }}>{site}/dashboard#api-keys</span>
            <span style={{ fg: theme.textMuted }}> · no account yet: enter your email to sign up</span>
          </text>
        </box>
      )}
      onConfirm={async (value) => {
        if (busy()) return
        const input = (value ?? "").trim()
        if (!input) return
        if (!looksLikeKey(normalizeKey(input)) && looksLikeEmail(input)) {
          setBusy(true)
          try {
            setBusyText("Sending login code…")
            const result = await requestEmailCode(input.toLowerCase())
            if (!result.ok) {
              toast.show({
                variant: "error",
                duration: 6000,
                message:
                  result.reason === "invalid"
                    ? `Could not send the code (${result.detail ?? "rejected"}). Check the address.`
                    : `Could not reach teai.io (${result.detail ?? "network"}). Try again.`,
              })
              return
            }
            openEmailCodePrompt(input.toLowerCase())
          } catch (error) {
            fail("Could not send the code", error)
          } finally {
            setBusy(false)
          }
          return
        }
        const key = normalizeKey(input)
        if (!looksLikeKey(key)) {
          toast.show({
            variant: "warning",
            message: "Paste a teai.io key (te_…) or your email address for a login code.",
          })
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
          const who = result.account.email ?? result.account.display_name ?? "teai.io"
          await finishWithKey(key, who, result.account.credits_remaining)
        } catch (error) {
          fail("Login failed", error)
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}
