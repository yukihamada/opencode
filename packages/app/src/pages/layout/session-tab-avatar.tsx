import type { LocalProject } from "@/context/layout"
import { getProjectAvatarVariant } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useSessionTabAvatarState, type SessionTabStatus } from "@/pages/layout/project-avatar-state"
import { ProjectAvatar } from "@sente-ai/ui/v2/project-avatar-v2"
import { SessionProgressIndicatorV2 } from "@sente-ai/session-ui/v2/session-progress-indicator-v2"
import { Show } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
  revealProjectOnHover?: boolean
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      revealProjectOnHover={props.revealProjectOnHover}
      status={state.status()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  revealProjectOnHover?: boolean
  status?: SessionTabStatus
}) {
  const status = () => props.status ?? "idle"
  const projectAvatar = () => (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={status() === "attention"}
    />
  )
  return (
    <span class="relative block size-4 shrink-0" data-status={status()}>
      <Show when={status() === "working"} fallback={projectAvatar()}>
        <span class="relative block size-4 shrink-0">
          <SessionProgressIndicatorV2
            class={`absolute inset-0 ${props.revealProjectOnHover === false ? "" : "group-hover:invisible"}`}
          />
          <Show when={props.revealProjectOnHover !== false}>
            <span class="invisible absolute inset-0 group-hover:visible">{projectAvatar()}</span>
          </Show>
        </span>
      </Show>
      <Show when={status() === "done"}>
        <span
          data-slot="session-tab-done-badge"
          aria-hidden="true"
          class="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-2 items-center justify-center rounded-full bg-v2-state-fg-success"
        >
          <svg viewBox="0 0 8 8" width="6" height="6" fill="none">
            <path d="M1.6 4.1L3.2 5.7L6.4 2.3" stroke="var(--v2-background-bg-base)" stroke-width="1.2" />
          </svg>
        </span>
      </Show>
    </span>
  )
}
