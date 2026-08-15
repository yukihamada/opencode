import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@sente-ai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~sente/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~sente/WorkspaceRef", {
  defaultValue: () => undefined,
})
