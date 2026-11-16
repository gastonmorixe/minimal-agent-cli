/**
 * Unit tests for the `--dry-run` helpers (src/startup/dry-run.ts).
 *
 * @module host/startup/dry-run.test
 */

import { describe, expect, test } from "bun:test"

import { LifecycleDeniedError } from "@minimal-agent/core/errors"

import {
  DRY_RUN_PLUGIN_ID,
  dryRunEnableIds,
  dryRunOutDefault,
  dryRunPluginGuard,
  dryRunPreflightError,
  isDryRun,
  isDryRunHalt,
  startDryRun,
} from "./dry-run.ts"

/** What core throws for a halted send: a `LifecycleDeniedError` with hook `message.willSend`. */
function sendDenied(reason = "dry-run: request built and printed, not sent"): LifecycleDeniedError {
  return new LifecycleDeniedError({ hook: "message.willSend", reason, pluginId: "dry-run" })
}

describe("isDryRun", () => {
  test("true for --dry-run in args", () => {
    expect(isDryRun(["-p", "hi", "--dry-run"], {})).toBe(true)
  })
  test("true for MINIMAL_AGENT_DRY_RUN=1", () => {
    expect(isDryRun(["-p", "hi"], { MINIMAL_AGENT_DRY_RUN: "1" })).toBe(true)
  })
  test("false for other env values and no flag", () => {
    expect(isDryRun(["-p", "hi"], {})).toBe(false)
    expect(isDryRun([], { MINIMAL_AGENT_DRY_RUN: "0" })).toBe(false)
    expect(isDryRun([], { MINIMAL_AGENT_DRY_RUN: "true" })).toBe(false)
  })
})

describe("dryRunEnableIds", () => {
  test("gives the plugin id when on", () => {
    expect(DRY_RUN_PLUGIN_ID).toBe("dry-run")
    expect(dryRunEnableIds(["--dry-run"], {})).toEqual(["dry-run"])
    expect(dryRunEnableIds([], { MINIMAL_AGENT_DRY_RUN: "1" })).toEqual(["dry-run"])
  })
  test("gives nothing when off", () => {
    expect(dryRunEnableIds([], {})).toEqual([])
  })
})

describe("isDryRunHalt", () => {
  test("true for a LifecycleDeniedError of message.willSend with the plugin reason", () => {
    expect(isDryRunHalt(sendDenied())).toBe(true)
  })
  test("true when the direct cause is that LifecycleDeniedError", () => {
    expect(isDryRunHalt(new Error("wrapped", { cause: sendDenied() }))).toBe(true)
  })
  test("false for a plain error, a non-error, and a deeper cause", () => {
    expect(isDryRunHalt(new Error("boom"))).toBe(false)
    expect(isDryRunHalt("LifecycleDeniedError")).toBe(false)
    expect(isDryRunHalt({ name: "LifecycleDeniedError" })).toBe(false)
    expect(isDryRunHalt(undefined)).toBe(false)
    const deep = new Error("outer", { cause: new Error("mid", { cause: sendDenied() }) })
    expect(isDryRunHalt(deep)).toBe(false)
  })
  test("matches on kind and fields, not on name or message", () => {
    // The CoreError message is always "": the old name+message match would fail.
    expect(sendDenied().message).toBe("")
    expect(isDryRunHalt(sendDenied().toJSON())).toBe(true)
    const named = new Error("dry-run: request built and printed, not sent")
    named.name = "LifecycleSendDeniedError"
    expect(isDryRunHalt(named)).toBe(false)
  })
  test("false for a deny with no reason, or on another hook", () => {
    expect(isDryRunHalt(new LifecycleDeniedError({ hook: "message.willSend" }))).toBe(false)
    expect(
      isDryRunHalt(
        new LifecycleDeniedError({
          hook: "compact.willRun",
          reason: "dry-run: request built and printed, not sent",
        }),
      ),
    ).toBe(false)
  })
  test("false for a send halt from another hook (security/policy deny)", () => {
    expect(isDryRunHalt(sendDenied("secrets found in the payload"))).toBe(false)
    expect(isDryRunHalt(new Error("wrapped", { cause: sendDenied("policy deny") }))).toBe(false)
  })
})

describe("dryRunPreflightError", () => {
  test("off: no error", () => {
    expect(dryRunPreflightError({ dryRun: false, command: "run", hasPrompt: false })).toBe(
      undefined,
    )
  })
  test("run with a prompt: no error", () => {
    expect(dryRunPreflightError({ dryRun: true, command: "run", hasPrompt: true })).toBe(undefined)
  })
  test("run with no prompt (REPL): error", () => {
    expect(dryRunPreflightError({ dryRun: true, command: "run", hasPrompt: false })).toBe(
      'fatal: --dry-run needs a prompt (-p, a positional prompt, or stdin "-")',
    )
  })
  test("host mode: error", () => {
    expect(dryRunPreflightError({ dryRun: true, command: "host-mode", hasPrompt: false })).toBe(
      "fatal: --dry-run does not work with --host-mode",
    )
  })
  test("a subcommand (auth-status prune --dry-run) reads its own flag: no error", () => {
    expect(dryRunPreflightError({ dryRun: true, command: "auth-status", hasPrompt: false })).toBe(
      undefined,
    )
  })
})

describe("dryRunPluginGuard", () => {
  test("off: no error, even with no plugin", () => {
    expect(dryRunPluginGuard(false, [])).toBe(undefined)
  })
  test("on and loaded: no error", () => {
    expect(dryRunPluginGuard(true, ["agents-md", "dry-run"])).toBe(undefined)
  })
  test("on and not loaded: fail closed", () => {
    expect(dryRunPluginGuard(true, ["agents-md"])).toBe(
      "fatal: --dry-run needs the dry-run plugin (ma-dry-run-plugin), but it did not load. Nothing was sent.",
    )
  })
  test("matches the manifest id, not the directory name", () => {
    expect(dryRunPluginGuard(true, ["ma-dry-run-plugin"])).not.toBe(undefined)
  })
})

describe("dryRunOutDefault", () => {
  test("protocol formats route the dump to stderr", () => {
    for (const fmt of ["json", "stream-json", "open-responses"] as const) {
      expect(dryRunOutDefault(true, fmt, {})).toBe("stderr")
    }
  })
  test("text format keeps stdout", () => {
    expect(dryRunOutDefault(true, "text", {})).toBe(undefined)
  })
  test("a user value wins", () => {
    expect(dryRunOutDefault(true, "json", { MINIMAL_AGENT_DRY_RUN_OUT: "req.json" })).toBe(
      undefined,
    )
  })
  test("off: no change", () => {
    expect(dryRunOutDefault(false, "json", {})).toBe(undefined)
  })
})

describe("startDryRun (boot guard, injected exit)", () => {
  class Exit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`)
    }
  }
  function boot(over: Partial<Parameters<typeof startDryRun>[0]> = {}) {
    const lines: string[] = []
    const env: Record<string, string | undefined> = {}
    const ctl = startDryRun({
      args: ["--dry-run", "--prompt", "hi"],
      env,
      io: { stderr: { write: (s: string) => lines.push(s) } },
      exit: (code: number): never => {
        throw new Exit(code)
      },
      outputFormat: "text",
      commandPlan: { command: "run" },
      orInput: { prompt: undefined },
      ...over,
    })
    return { ctl, lines, env }
  }
  const loaderWith = (ids: string[]) => ({ loadedPluginIds: () => ids })

  test("plugin not loaded: exit 1 with the fail-closed line", () => {
    const { ctl, lines } = boot()
    expect(() => ctl.checked(loaderWith(["agents-md"]))).toThrow(new Exit(1))
    expect(lines.join("")).toContain("but it did not load. Nothing was sent.")
  })

  test("plugin loaded: the loader comes back unchanged", () => {
    const { ctl, lines } = boot()
    const loader = loaderWith(["dry-run"])
    expect(ctl.checked(loader)).toBe(loader)
    expect(lines).toEqual([])
  })

  test("no prompt: exit 1 before any plugin load", () => {
    expect(() => boot({ args: ["--dry-run"] })).toThrow(new Exit(1))
  })

  test("an open-responses request prompt counts as a prompt", () => {
    expect(boot({ args: ["--dry-run"], orInput: { prompt: "hi" } }).ctl.on).toBe(true)
  })

  test("json output sets the dump target to stderr", () => {
    expect(boot({ outputFormat: "json" }).env.MINIMAL_AGENT_DRY_RUN_OUT).toBe("stderr")
    expect(boot().env.MINIMAL_AGENT_DRY_RUN_OUT).toBeUndefined()
  })

  test("off: no exit, no env change, the guard passes", () => {
    const { ctl, env } = boot({ args: ["--prompt", "hi"], outputFormat: "json" })
    expect(ctl.on).toBe(false)
    expect(env.MINIMAL_AGENT_DRY_RUN_OUT).toBeUndefined()
    const loader = loaderWith([])
    expect(ctl.checked(loader)).toBe(loader)
  })
})
