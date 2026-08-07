import { describe, expect, test } from "bun:test"

import packageJson from "../package.json"
import { main, type TextWriter, VERSION } from "./index.ts"

function capture() {
  let stdout = ""
  let stderr = ""
  const writer = (append: (text: string) => void): TextWriter => ({ write: append })

  return {
    host: {
      stdout: writer((text) => (stdout += text)),
      stderr: writer((text) => (stderr += text)),
    },
    output: () => ({ stdout, stderr }),
  }
}

function run(argv: readonly string[]) {
  const io = capture()
  const exitCode = main(argv, io.host)
  return { exitCode, ...io.output() }
}

describe("minimal-agent-cli scaffold", () => {
  test("shows help for no arguments", () => {
    const result = run([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Usage: minimal-agent [options]")
    expect(result.stderr).toBe("")
  })

  test.each(["--help", "-h"])("shows help for %s", (argument) => {
    expect(run([argument])).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining("--version"),
      stderr: "",
    })
  })

  test.each(["--version", "-V"])("shows the canonical version for %s", (argument) => {
    expect(run([argument])).toEqual({
      exitCode: 0,
      stdout: `minimal-agent-cli ${VERSION}\n`,
      stderr: "",
    })
  })

  test("keeps the source version synchronized with package metadata", () => {
    expect(VERSION).toBe(packageJson.version)
  })

  test("rejects unknown arguments on stderr", () => {
    expect(run(["--wat"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "minimal-agent-cli: unknown argument '--wat'\nTry 'minimal-agent --help'.\n",
    })
  })
})

describe("executable smoke tests", () => {
  test("runs the source bin and reports its version", () => {
    const result = Bun.spawnSync([process.execPath, "run", "src/index.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`minimal-agent-cli ${VERSION}\n`)
    expect(result.stderr.toString()).toBe("")
  })

  test("propagates unknown-argument failure from the source bin", () => {
    const result = Bun.spawnSync([process.execPath, "run", "src/index.ts", "--wat"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toContain("unknown argument '--wat'")
  })
})
