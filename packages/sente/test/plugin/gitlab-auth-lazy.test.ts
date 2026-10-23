import { expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"
import { gitlabAuthPlugin } from "opencode-gitlab-auth"

// patches/opencode-gitlab-auth@2.1.0.patch: the OAuth callback server (fastify) is imported on
// the first login instead of at every start (~15-25ms of module evaluation before the first request).
const dist = path.dirname(Bun.resolveSync("opencode-gitlab-auth", import.meta.dir))

test("gitlab auth plugin does not import the callback server at load time", async () => {
  for (const file of ["index.js", "oauth-flow.js"]) {
    const source = await readFile(path.join(dist, file), "utf8")
    expect(source).not.toMatch(/^import .*callback-server/m)
    expect(source).toContain("await import('./callback-server.js')")
  }
})

test("gitlab auth plugin still exposes its auth hook", async () => {
  const hooks = await gitlabAuthPlugin({} as never)
  expect(hooks.auth?.provider).toBe("gitlab")
  expect(hooks.auth?.methods?.length).toBeGreaterThan(0)
})

test("the callback server module still loads on demand", async () => {
  const mod = await import(path.join(dist, "callback-server.js"))
  expect(typeof mod.CallbackServer).toBe("function")
})
