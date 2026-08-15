import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.SENTE_CHANNEL ?? "dev"}`

await $`cd ../sente && bun script/build-node.ts`
await downloadCliToResources()
