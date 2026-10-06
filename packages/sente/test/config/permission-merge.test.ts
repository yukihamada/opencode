import { describe, expect, test } from "bun:test"
import { mergeDeep } from "remeda"
import { mergePermission } from "../../src/config/config"
import { Permission } from "../../src/permission"

// The shape that broke headless runs: a personal config that mentions `bash`,
// loaded before a stricter policy file that opens with a catch-all.
const personal = { external_directory: "allow", bash: { "*": "allow", "*security*": "ask" } }
const policy = {
  "*": "ask",
  read: "allow",
  edit: "allow",
  bash: { "*": "ask", ls: "allow", "ls *": "allow", "rm *": "deny" },
  external_directory: { "*": "deny" },
}

const action = (config: unknown, permission: string, pattern: string) =>
  Permission.evaluate(permission, pattern, Permission.fromConfig(config as never)).action

describe("mergePermission", () => {
  test("a plain deep merge lets the later file's catch-all override its own rules", () => {
    const merged = mergeDeep(personal, policy)
    expect(Object.keys(merged).indexOf("*")).toBeGreaterThan(Object.keys(merged).indexOf("bash"))
    expect(action(merged, "bash", "ls")).toBe("ask")
  })

  test("the later file's specific rules survive its own catch-all", () => {
    const merged = mergePermission(personal, policy)
    expect(action(merged, "bash", "ls")).toBe("allow")
    expect(action(merged, "bash", "ls -la")).toBe("allow")
    expect(action(merged, "bash", "rm -rf x")).toBe("deny")
    expect(action(merged, "bash", "python3 x.py")).toBe("ask")
    expect(action(merged, "read", "a.txt")).toBe("allow")
    expect(action(merged, "external_directory", "/etc")).toBe("deny")
    expect(action(merged, "some_mcp_tool", "*")).toBe("ask")
  })

  test("the later file's pattern beats an earlier pattern for the same tool", () => {
    const merged = mergePermission({ bash: { "git *": "allow" } }, { bash: { "*": "ask", "git status*": "allow" } })
    expect(action(merged, "bash", "git push")).toBe("ask")
    expect(action(merged, "bash", "git status")).toBe("allow")
  })

  test("an earlier catch-all cannot override a later explicit rule", () => {
    const merged = mergePermission({ bash: "allow", "*": "deny" }, { bash: "ask" })
    expect(action(merged, "bash", "ls")).toBe("ask")
    expect(action(merged, "edit", "a.txt")).toBe("deny")
  })

  test("keys only the earlier file has are kept", () => {
    const merged = mergePermission({ webfetch: "deny", bash: { "ls *": "allow" } }, { bash: { "cat *": "allow" } })
    expect(action(merged, "webfetch", "*")).toBe("deny")
    expect(action(merged, "bash", "ls x")).toBe("allow")
    expect(action(merged, "bash", "cat x")).toBe("allow")
  })

  test("a missing side leaves the other untouched", () => {
    expect(mergePermission(personal, undefined)).toEqual(personal)
    expect(mergePermission(undefined, policy)).toEqual(policy)
  })
})
