import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  // OpenTUI 0.6.3 throws InvalidPhase when setTerminalTitle runs on a disposed session.
  // Attempt to clear the title regardless and ignore the error once disposed, so tests
  // that mock setTerminalTitle still observe the clear even when the Effect lifecycle
  // destroys the renderer before the SIGHUP handler runs.
  try {
    renderer.setTerminalTitle("")
  } catch {
    // Session already disposed; nothing to clear.
  }
  if (renderer.isDestroyed) return
  renderer.destroy()
}
