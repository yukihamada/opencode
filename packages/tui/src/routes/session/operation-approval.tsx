import type { Theme } from "../../context/theme"
import { operationApprovalText } from "../../util/operation-approval-text"

export function OperationApproval(props: { operation: string; fingerprint: string; locale: string; theme: Pick<Theme, "text" | "textMuted"> }) {
  return (
    <box paddingLeft={1} gap={1}>
      <text fg={props.theme.textMuted}>{operationApprovalText(props.locale).notice}</text>
      <text fg={props.theme.text}>{props.operation}</text>
      <text fg={props.theme.textMuted}>{props.fingerprint}</text>
    </box>
  )
}

export function approvalOptions(permission: string, always: string[], locale: string): Record<string, string> {
  const text = operationApprovalText(locale)
  if (permission === "request_cost" || always.length === 0) {
    return { once: text.once, reject: text.reject }
  }
  return { once: text.allowOnce, always: text.always, reject: text.reject }
}
