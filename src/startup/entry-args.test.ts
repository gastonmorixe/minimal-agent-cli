import { describe, expect, it } from "bun:test"

import { prepareEntrypointArgs } from "./entry-args.ts"

/** Sentinel thrown by the fake exit so control flow stops like `process.exit`. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function makeHarness() {
  const writes: string[] = []
  let helpCalls = 0
  const deps = {
    stderr: { write: (s: string) => (writes.push(s), true) as unknown as boolean },
    exit: (code: number): never => {
      throw new ExitSignal(code)
    },
    printHelp: () => {
      helpCalls++
    },
  }
  return { writes, deps, helpCalls: () => helpCalls }
}

describe("prepareEntrypointArgs", () => {
  it("rejects smart-dash flags with exit 2 and a fix-it hint", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--resume\u2013same-sid", "abc"],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(h.writes.join("")).toContain("non-ASCII dash")
  })

  it("dispatches --help and exits 0 without parsing further", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({ rawArgv: ["--help"], env: {}, cwd: "/tmp", ...h.deps })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(0)
    expect(h.helpCalls()).toBe(1)
  })

  it("passes the resolved help request to the help hook (command path)", () => {
    const reqs: unknown[] = []
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["sessions", "dump", "--help"],
        env: {},
        cwd: "/tmp",
        ...makeHarness().deps,
        printHelp: (req) => {
          reqs.push(req)
        },
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(0)
    expect(reqs).toEqual([{ kind: "help", path: ["sessions", "dump"] }])
  })

  it("an unknown help path exits 2 and the hook gets the unknown request", () => {
    const reqs: unknown[] = []
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["auth-status", "prun", "-h"],
        env: {},
        cwd: "/tmp",
        ...makeHarness().deps,
        printHelp: (req) => {
          reqs.push(req)
        },
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(reqs).toEqual([
      { kind: "unknown", at: ["auth-status"], token: "prun", suggestions: ["prune", "plan"] },
    ])
  })

  it("help resolves before env writes (--debug --help leaves env untouched)", () => {
    const env: Record<string, string | undefined> = {}
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--debug", "--verbose", "sessions", "--help"],
        env,
        cwd: "/tmp",
        ...makeHarness().deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(0)
    expect(env.DEBUG).toBeUndefined()
    expect(env.VERBOSE).toBeUndefined()
  })

  it("writes help to the stdout sink and a help error to stderr", () => {
    const out: string[] = []
    const h = makeHarness()
    const { printHelp: _unused, ...deps } = h.deps
    const run = (rawArgv: string[]): number | undefined => {
      try {
        prepareEntrypointArgs({
          rawArgv,
          env: { NO_COLOR: "1", COLUMNS: "80" },
          cwd: "/tmp",
          ...deps,
          stdout: { write: (s: string) => out.push(s) },
        })
      } catch (e) {
        if (e instanceof ExitSignal) return e.code
        throw e
      }
      return undefined
    }
    expect(run(["help", "sessions"])).toBe(0)
    expect(out.join("")).toStartWith("  minimal-agent sessions\n")
    expect(h.writes).toEqual([])
    out.length = 0
    expect(run(["help", "bogus"])).toBe(2)
    expect(out).toEqual([])
    expect(h.writes.join("")).toStartWith("error: ")
  })

  it("auth-status plan --all is not a help request (normal plan)", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["auth-status", "plan", "--all"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(h.helpCalls()).toBe(0)
    expect(prepared.commandPlan.command).toBe("auth-status")
  })

  it("propagates --debug/--verbose/--show-hidden-chars into env", () => {
    const h = makeHarness()
    const env: Record<string, string | undefined> = {}
    prepareEntrypointArgs({
      rawArgv: ["--debug", "--verbose", "--show-hidden-chars", "--skip-quota"],
      env,
      cwd: "/tmp",
      ...h.deps,
    })
    expect(env.DEBUG).toBe("1")
    expect(env.VERBOSE).toBe("1")
    expect(env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS).toBe("1")
  })

  it("returns normalized args, a command plan, and a working readFlagValue", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["models"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    // `models` subcommand normalizes to --list-models and plans list-models.
    expect(prepared.args).toContain("--list-models")
    expect(prepared.commandPlan.command).toBe("list-models")
    expect(prepared.readFlagValue("--nope")).toBeUndefined()
  })

  it("readFlagValue reads both inline and spaced flag forms", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--auth-method=oauth", "hello"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(prepared.readFlagValue("--auth-method")).toBe("oauth")
  })

  it("extractPrompt classifies a literal positional prompt", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["hello world"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBe("hello world")
  })

  it("extractPrompt slurps stdin for the `-` sentinel", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["-"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    async function* fakeStdin() {
      yield Buffer.from("piped ")
      yield Buffer.from("prompt\n")
    }
    expect(await prepared.extractPrompt(fakeStdin())).toBe("piped prompt")
  })

  it("extractPrompt returns null for interactive (no prompt) args", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--skip-quota"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBeNull()
  })

  it("rejects provider preamble override without unsafe flag (exit 2)", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--provider-system-preamble", "custom preamble"],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(h.writes.join("")).toContain("providerPreamble override requires")
  })

  it("accepts provider preamble override with unsafe flag", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: [
        "--provider-system-preamble",
        "custom preamble",
        "--unsafe-system-prompt-overrides",
      ],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(prepared.opts.systemPromptOverrides.providerPreamble).toEqual({
      kind: "replace",
      text: "custom preamble",
    })
  })

  it("resolves system prompt overrides from CLI flags", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--system-instructions", "custom instructions", "--no-system-loop-safety"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(prepared.opts.systemPromptOverrides.instructions).toEqual({
      kind: "replace",
      text: "custom instructions",
    })
    expect(prepared.opts.systemPromptOverrides.loopSafety).toEqual({ kind: "omit" })
  })

  it("rejects --effort --fast as a missing effort level (does not swallow --fast)", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--effort", "--fast"],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(h.writes.join("")).toContain("--effort requires a level")
    expect(h.writes.join("")).toContain('Got "--fast"')
  })

  it("rejects a path-like --session-id with exit 2 before any session file is touched", () => {
    for (const bad of ["../../x", "a/b", "a\\b", "x\u0000y"]) {
      const h = makeHarness()
      let code: number | undefined
      try {
        prepareEntrypointArgs({
          rawArgv: ["--session-id", bad],
          env: {},
          cwd: "/tmp",
          ...h.deps,
        })
      } catch (e) {
        if (e instanceof ExitSignal) code = e.code
        else throw e
      }
      expect(code).toBe(2)
      expect(h.writes.join("")).toContain("setSessionId: not a UUID")
    }
  })
})
