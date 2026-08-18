import { registerCustomTheme } from "@pierre/diffs"
import { SenteTheme } from "./marked-theme"

let registered = false

export function registerSenteTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Sente", () => Promise.resolve(SenteTheme))
}
