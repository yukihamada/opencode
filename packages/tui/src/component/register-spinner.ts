import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerSenteSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
