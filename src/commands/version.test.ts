/**
 * Unit tests for the `version` command and its startup dispatch (plan 2.1, 2.3).
 *
 * @module commands/version.test
 */

import { describe, expect, test } from "bun:test"

import { normalizeBuildInfo } from "../cli/build-info.ts"
import { builtinRegistry } from "../cli/registry/index.ts"
import { prepareEntrypointArgs } from "../startup/entry-args.ts"
import { isVersionRequest, renderVersion } from "./version.ts"

const reg = builtinRegistry()

describe("isVersionRequest", () => {
  test("version, --version, -V", () => {
    expect(isVersionRequest(["version"], reg)).toBe(true)
    expect(isVersionRequest(["--version"], reg)).toBe(true)
    expect(isVersionRequest(["-V"], reg)).toBe(true)
    expect(isVersionRequest(["--version", "--json"], reg)).toBe(true)
  })

  test("a flag value, a prompt word, host-mode args are not a request", () => {
    expect(isVersionRequest(["--prompt", "--version"], reg)).toBe(false)
    expect(isVersionRequest(["explain", "version"], reg)).toBe(false)
    expect(isVersionRequest(["--host-mode", "acp", "--version"], reg)).toBe(false)
    expect(isVersionRequest([], reg)).toBe(false)
    // -v is --verbose, not the version.
    expect(isVersionRequest(["-v"], reg)).toBe(false)
  })
})

describe("renderVersion", () => {
  const info = normalizeBuildInfo({ version: "0.1.0", mode: "dev" })
  test("one line by default", () => {
    const out = renderVersion([], info)
    expect(out.split("\n")).toHaveLength(2)
    expect(out).toStartWith("minimal-agent 0.1.0 (cli dev, core dev, plugins dev) bun ")
  })
  test("--json and --output-format json print the object", () => {
    expect(JSON.parse(renderVersion(["--json"], info))).toEqual(info)
    expect(JSON.parse(renderVersion(["--output-format", "json"], info))).toEqual(info)
  })
})

/** Sentinel thrown by the fake exit so control flow stops like `process.exit`. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

/** Run prepareEntrypointArgs and capture the exit code, stdout, and stderr. */
function runEntry(rawArgv: string[]): { code: number | undefined; out: string; err: string } {
  let out = ""
  let err = ""
  let code: number | undefined
  try {
    prepareEntrypointArgs({
      rawArgv,
      env: {},
      cwd: "/tmp",
      stdout: { write: (s: string) => ((out += s), true) as unknown as boolean },
      stderr: { write: (s: string) => ((err += s), true) as unknown as boolean },
      exit: (c: number): never => {
        throw new ExitSignal(c)
      },
      helpCatalog: () => [],
    })
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  }
  return { code, out, err }
}

describe("startup dispatch", () => {
  test("--version exits 0 with one line on stdout", () => {
    const r = runEntry(["--version"])
    expect(r.code).toBe(0)
    expect(r.out).toStartWith("minimal-agent ")
    expect(r.err).toBe("")
  })

  test("version --json exits 0 with JSON", () => {
    const r = runEntry(["version", "--json"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).mode).toBe("source")
  })

  test("an unknown flag exits 2 with the error line", () => {
    const r = runEntry(["--bogus"])
    expect(r.code).toBe(2)
    expect(r.err).toBe("unknown flag --bogus (see minimal-agent --help)\n")
  })

  test("--help wins over an unknown flag (help accepts any flag)", () => {
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--bogus", "--help"],
        env: {},
        cwd: "/tmp",
        exit: (c: number): never => {
          throw new ExitSignal(c)
        },
        printHelp: () => {},
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(0)
  })

  test("a flag a plugin command declares is not unknown", () => {
    let err = ""
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--plugin-thing", "--dry-run"],
        env: {},
        cwd: "/tmp",
        stderr: { write: (s: string) => ((err += s), true) as unknown as boolean },
        exit: (c: number): never => {
          throw new ExitSignal(c)
        },
        helpCatalog: () => [
          {
            pluginId: "p",
            root: "embedded",
            effectiveOn: true,
            note: "",
            hostModes: [],
            cli: {
              contractVersion: 1,
              commands: [
                {
                  name: "thing",
                  summary: "x",
                  flags: [{ name: "plugin-thing", type: "boolean", summary: "x" }],
                },
              ],
            },
          },
        ],
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(err).not.toContain("unknown flag")
    expect(code).not.toBe(2)
  })
})
