import { createResource, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { accountStatus, accountText, siteBase } from "../util/teai"

export function DialogTeaiAccount(props: { remote: boolean }) {
  const { theme } = useTheme()
  const text = accountText()
  const [status] = createResource(async () => {
    try {
      return { value: await accountStatus(), error: undefined }
    } catch {
      return { value: undefined, error: text.failed }
    }
  })
  return (
    <box padding={1} gap={1}>
      <text fg={theme.text}>{text.title}</text>
      <Show when={props.remote}><text fg={theme.textMuted}>{text.remote}</text></Show>
      <Show when={!status.loading} fallback={<text fg={theme.textMuted}>{text.loading}</text>}>
        <Show when={status()?.error}><text fg={theme.error}>{status()?.error}</text></Show>
        <Show when={status()?.value}>{(value) => (
          <box gap={1}>
            <text fg={theme.text}>{value().state === "authenticated" ? text.signedIn : value().state === "protected" ? text.protected : value().state === "missing" ? text.signedOut : value().state === "network" ? text.network : text.invalid}</text>
            <Show when={value().account}>{(account) => (
              <box>
                <text fg={theme.text}>{account().email ?? account().display_name ?? "teai.io"} · {account().plan ?? text.unknown}</text>
                <text fg={theme.text}>{text.credits}: {account().credits_remaining?.toLocaleString() ?? text.unknown} cr</text>
                <Show when={account().credits_remaining !== undefined && account().credits_remaining! <= 0}>
                  <text fg={theme.error}>{text.low} · {siteBase()}/pricing</text>
                </Show>
                <text fg={theme.textMuted}>{value().temporary ? text.temporary : text.persistent}</text>
              </box>
            )}</Show>
            <text fg={theme.textMuted}>{text.source}: {value().source === "env" ? text.env : text.saved}</text>
            <Show when={value().conflict}><text fg={theme.error}>{text.conflict}</text></Show>
          </box>
        )}</Show>
      </Show>
      <text fg={theme.textMuted}>{text.hint}</text>
    </box>
  )
}
