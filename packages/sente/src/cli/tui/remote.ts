import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Global } from "@sente-ai/core/global"

export async function registerRemote(input: { url: string; directory: string; authorization: string }, root = path.join(Global.Path.state, "remote")) {
  const url = new URL(input.url)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("Remote session bridge requires a loopback listener")
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const file = path.join(root, `${process.pid}-${randomBytes(8).toString("hex")}.json`)
  await fs.writeFile(file, JSON.stringify({ ...input, pid: process.pid }), { mode: 0o600, flag: "wx" })
  return async () => {
    await fs.rm(file, { force: true })
  }
}
