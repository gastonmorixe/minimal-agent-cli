import { describe, expect, test } from "bun:test"

import { builtinRegistry } from "./index.ts"
import { COMMAND_FORM_ORDER, resolveCommandRoute, wordFormIndex } from "./route.ts"

const route = (...raw: string[]) => resolveCommandRoute(raw, builtinRegistry())

describe("resolveCommandRoute: word form", () => {
  test("walks the path strictly and keeps args and flags in argv order", () => {
    expect(route("auth-status", "plan", "work", "--all", "--parallel", "2")).toEqual({
      kind: "builtin",
      path: ["auth-status", "plan"],
      form: "word",
      args: ["work"],
      flags: ["--all", "--parallel", "2"],
    })
  })

  test("a flag value is not a path segment (lead decision 5)", () => {
    expect(route("auth-status", "--name", "refresh")).toMatchObject({
      path: ["auth-status"],
      args: [],
      flags: ["--name", "refresh"],
    })
    expect(route("auth-status", "--parallel", "plan")).toMatchObject({ path: ["auth-status"] })
  })

  test("provider <id> <command>: the id is an arg before the child", () => {
    expect(route("provider", "openai", "login", "oauth")).toMatchObject({
      path: ["provider", "login"],
      args: ["openai", "oauth"],
    })
    expect(route("provider", "openai")).toMatchObject({ path: ["provider"], args: ["openai"] })
    expect(route("provider", "openai", "other")).toMatchObject({
      path: ["provider"],
      args: ["openai", "other"],
    })
  })

  test("nested and sugar paths", () => {
    expect(route("providers", "models", "openai")).toMatchObject({
      path: ["providers", "models"],
      args: ["openai"],
    })
    expect(route("sessions", "dump", "last")).toMatchObject({
      path: ["sessions", "dump"],
      args: ["last"],
    })
    expect(route("flags", "list")).toMatchObject({ path: ["flags", "list"] })
    expect(route("sessions", "auth")).toMatchObject({ path: ["sessions"], args: ["auth"] })
  })

  test("the first form in the old order wins, word or flag", () => {
    expect(route("login", "--list-models")).toMatchObject({
      path: ["providers", "models"],
      form: "flag",
    })
    expect(route("logout", "--auth-status")).toMatchObject({ path: ["logout"], form: "word" })
  })
})

describe("resolveCommandRoute: flag form", () => {
  test("uses the command-form order", () => {
    expect(route("--sessions", "--usage")).toMatchObject({ path: ["sessions"], form: "flag" })
    expect(route("--list-models", "--list-models-live")).toMatchObject({
      path: ["providers", "models-live"],
    })
    expect(route("--login", "--logout", "--auth-status")).toMatchObject({ path: ["login"] })
  })

  test("aliases and --x=value select the form", () => {
    expect(route("--models")).toMatchObject({ path: ["providers", "models"] })
    expect(route("--usage=ytd")).toMatchObject({ path: ["usage"], flags: ["--usage=ytd"] })
    expect(route("--dump=abc")).toMatchObject({ path: ["sessions", "dump"] })
  })

  test("--dump needs a value", () => {
    expect(route("--dump")).toBeUndefined()
  })

  test("only --auth-status walks its children", () => {
    expect(route("--auth-status", "plan")).toMatchObject({
      path: ["auth-status", "plan"],
      form: "flag",
      args: [],
    })
    expect(route("--list-flags", "list")).toMatchObject({ path: ["flags"], args: ["list"] })
    // `--sessions` takes an optional value: `list` is that value.
    expect(route("--sessions", "list")).toMatchObject({
      path: ["sessions"],
      args: [],
      flags: ["--sessions", "list"],
    })
  })

  test("--host-mode comes after the command forms", () => {
    expect(route("--host-mode", "acp")).toEqual({ kind: "host-mode", id: "acp" })
    expect(route("--host-mode=acp")).toEqual({ kind: "host-mode", id: "acp" })
    expect(route("--auth-status", "--host-mode", "acp")).toMatchObject({ path: ["auth-status"] })
  })
})

describe("resolveCommandRoute: root run path", () => {
  test("no argv, a prompt, and stdin give undefined", () => {
    expect(route()).toBeUndefined()
    expect(route("hello")).toBeUndefined()
    expect(route("-")).toBeUndefined()
    expect(route("-p", "hi")).toBeUndefined()
    expect(route("--parallel", "8", "hello")).toBeUndefined()
  })

  test("resume word forms are runs", () => {
    expect(route("resume", "abc")).toBeUndefined()
    expect(route("resume-same", "abc")).toBeUndefined()
    expect(route("sessions", "resume", "abc")).toBeUndefined()
    expect(route("sessions", "resume-same", "last")).toBeUndefined()
    expect(route("resume", "abc", "--list-models")).toMatchObject({ path: ["providers", "models"] })
  })

  test("V-19 (Q-9): a one-word prompt is no command, plugin alone too", () => {
    expect(route("schedule")).toBeUndefined()
    expect(route("schedule", "list")).toBeUndefined()
    expect(route("plugin")).toBeUndefined()
    expect(route("plugin", "--json")).toBeUndefined()
    expect(route("plugin", "schedule")).toBeUndefined()
  })

  test("provider with no id and sessions dump with no sid are runs", () => {
    expect(route("provider")).toBeUndefined()
    expect(route("sessions", "dump")).toBeUndefined()
  })
})

describe("COMMAND_FORM_ORDER", () => {
  test("every flag is a global command-form flag and every path exists", () => {
    const reg = builtinRegistry()
    for (const form of COMMAND_FORM_ORDER) {
      const spec = reg.globalFlags.find((s) => s.name === form.flag)
      expect(spec?.group).toBe("command-forms")
      const word = route(...form.path, ...(form.flag === "dump" ? ["x"] : []))
      expect(word).toMatchObject({ path: form.path })
    }
  })

  test("every top-level command has a form, except run forms, help, version, and update", () => {
    const reg = builtinRegistry()
    const noForm = reg.commands.filter((c) => wordFormIndex([c.name]) === -1).map((c) => c.name)
    // `version` and `--version` resolve before routing (startup/entry-args.ts).
    // `update` runs before routing too (startup/update-dispatch.ts), word form only.
    expect(noForm.sort()).toEqual(["help", "resume", "resume-same", "update", "version"])
  })
})
