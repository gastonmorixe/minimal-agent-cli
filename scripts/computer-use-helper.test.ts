/**
 * Tests for `scripts/computer-use-helper.ts`: the target to swiftc arch
 * mapping, the host run check, the swiftc command, and the build flow with
 * a fake runner (no swiftc, no codesign, no helper run).
 *
 * @module scripts/computer-use-helper.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildComputerUseHelper,
  canRunOnHost,
  codesignFlags,
  HELPER_KEY,
  HELPER_PACKAGE,
  type HelperBuildDeps,
  HelperBuildError,
  helperSources,
  type Runner,
  selftestSummary,
  swiftArchOf,
  swiftcCommand,
} from "./computer-use-helper.ts"
import { RELEASE_TARGETS } from "./release/targets.ts"

let root: string
let plugins: string
let outRoot: string

/** Write the helper sources under the fixture plugins dir. */
function sources(names: readonly string[]): void {
  const dir = join(plugins, HELPER_PACKAGE, "native", "Sources")
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, name), "// swift\n")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-cu-helper-"))
  plugins = join(root, "plugins")
  outRoot = join(root, "out")
  mkdirSync(plugins, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("swiftArchOf", () => {
  test("darwin targets map to the swiftc arch, by id and by Bun string", () => {
    expect(swiftArchOf("darwin-arm64")).toBe("arm64")
    expect(swiftArchOf("bun-darwin-arm64")).toBe("arm64")
    expect(swiftArchOf("darwin-x64")).toBe("x86_64")
    expect(swiftArchOf("bun-darwin-x64")).toBe("x86_64")
    expect(swiftArchOf("bun-darwin-aarch64")).toBe("arm64")
  })

  test("linux and unknown targets get no helper", () => {
    for (const t of RELEASE_TARGETS.filter((x) => x.os === "linux")) {
      expect(swiftArchOf(t.id)).toBeUndefined()
      expect(swiftArchOf(t.bun)).toBeUndefined()
    }
    expect(swiftArchOf("windows-x64")).toBeUndefined()
    expect(swiftArchOf("")).toBeUndefined()
  })

  test("every darwin release target has an arch", () => {
    const darwin = RELEASE_TARGETS.filter((t) => t.os === "darwin")
    expect(darwin.map((t) => [t.id, swiftArchOf(t.id)])).toEqual([
      ["darwin-arm64", "arm64"],
      ["darwin-x64", "x86_64"],
    ])
  })
})

describe("canRunOnHost", () => {
  const mac = (arch: string) => ({ platform: "darwin", arch })
  test("arm64 runs only on an arm64 Mac", () => {
    expect(canRunOnHost("arm64", mac("arm64"), false)).toBe(true)
    expect(canRunOnHost("arm64", mac("x64"), true)).toBe(false)
    expect(canRunOnHost("arm64", { platform: "linux", arch: "arm64" }, false)).toBe(false)
  })
  test("x86_64 runs on an Intel Mac, or on an arm64 Mac with Rosetta", () => {
    expect(canRunOnHost("x86_64", mac("x64"), false)).toBe(true)
    expect(canRunOnHost("x86_64", mac("arm64"), true)).toBe(true)
    expect(canRunOnHost("x86_64", mac("arm64"), false)).toBe(false)
    expect(canRunOnHost("x86_64", { platform: "linux", arch: "x64" }, true)).toBe(false)
  })
})

describe("helperSources and swiftcCommand", () => {
  test("only .swift files, sorted, as full paths", () => {
    sources(["main.swift", "AXElement.swift", "Json.swift", "ComputerUseHelper.entitlements"])
    mkdirSync(join(plugins, HELPER_PACKAGE, "native", "Sources", "Dir.swift"))
    const dir = join(plugins, HELPER_PACKAGE, "native", "Sources")
    expect(helperSources(plugins)).toEqual([
      join(dir, "AXElement.swift"),
      join(dir, "Json.swift"),
      join(dir, "main.swift"),
    ])
  })

  test("an absent Sources dir gives no files", () => {
    expect(helperSources(plugins)).toEqual([])
  })

  test("the command has the target arch, the macOS 14 floor and the ad-hoc signature", () => {
    expect(swiftcCommand("x86_64", ["/s/a.swift", "/s/b.swift"], "/o/H")).toEqual([
      "xcrun",
      "swiftc",
      "-O",
      "-target",
      "x86_64-apple-macos14",
      "-module-name",
      "ComputerUseHelper",
      "-Xlinker",
      "-adhoc_codesign",
      "/s/a.swift",
      "/s/b.swift",
      "-o",
      "/o/H",
    ])
    expect(swiftcCommand("arm64", [], "/o/H")[4]).toBe("arm64-apple-macos14")
  })
})

describe("output parsers", () => {
  test("codesignFlags reads the flags value", () => {
    const out =
      "Executable=/x\nIdentifier=ComputerUseHelper\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded\n"
    expect(codesignFlags(out)).toBe("0x20002(adhoc,linker-signed)")
    expect(codesignFlags("code object is not signed at all")).toBeUndefined()
  })
  test("selftestSummary needs every check to pass", () => {
    expect(selftestSummary("x\nselftest: 79/79 passed\n")).toBe("selftest: 79/79 passed")
    expect(selftestSummary("selftest: 78/79 passed")).toBeUndefined()
    expect(selftestSummary("")).toBeUndefined()
  })
})

describe("buildComputerUseHelper", () => {
  /** A fake host: records commands, writes the swiftc output, answers codesign and selftest. */
  function fakeDeps(over: Partial<HelperBuildDeps> & { fail?: string } = {}): {
    deps: HelperBuildDeps
    calls: string[][]
  } {
    const calls: string[][] = []
    const run: Runner = async (cmd) => {
      calls.push(cmd)
      // `swiftc`, `--verify`, `-dv` or `--selftest`.
      if (over.fail !== undefined && cmd[1] === over.fail) return { exitCode: 1, out: "boom" }
      if (cmd[0] === "xcrun") {
        const out = cmd[cmd.length - 1] ?? ""
        writeFileSync(out, "MACHO")
        return { exitCode: 0, out: "" }
      }
      if (cmd[0] === "codesign" && cmd[1] === "-dv") {
        return { exitCode: 0, out: "CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed) x" }
      }
      if (cmd[1] === "--selftest") return { exitCode: 0, out: "selftest: 79/79 passed\n" }
      return { exitCode: 0, out: "" }
    }
    return {
      deps: {
        run,
        toolchainGap: () => undefined,
        host: { platform: "darwin", arch: "arm64" },
        rosetta: () => false,
        ...over,
      },
      calls,
    }
  }

  const req = (target: string, mode: "dev" | "release" = "dev") => ({
    target,
    mode,
    pluginsDir: plugins,
    outRoot,
  })

  test("a linux target builds nothing and runs nothing", async () => {
    sources(["main.swift"])
    const { deps, calls } = fakeDeps()
    for (const target of ["linux-x64", "bun-linux-arm64-musl"]) {
      expect(await buildComputerUseHelper(req(target, "release"), deps)).toEqual({
        kind: "not-darwin",
      })
    }
    expect(calls).toEqual([])
    expect(existsSync(outRoot)).toBe(false)
  })

  test("darwin-arm64 on an arm64 host: swiftc, verify, flags, selftest, in that order", async () => {
    sources(["b.swift", "a.swift"])
    const { deps, calls } = fakeDeps()
    const r = await buildComputerUseHelper(req("bun-darwin-arm64"), deps)
    const out = join(outRoot, "darwin-arm64", "ComputerUseHelper")
    const src = join(plugins, HELPER_PACKAGE, "native", "Sources")
    expect(r).toEqual({
      kind: "built",
      id: "darwin-arm64",
      arch: "arm64",
      path: out,
      size: 5,
      flags: "0x20002(adhoc,linker-signed)",
      selftest: "selftest: 79/79 passed",
    })
    expect(calls).toEqual([
      swiftcCommand("arm64", [join(src, "a.swift"), join(src, "b.swift")], out),
      ["codesign", "--verify", "--strict", out],
      ["codesign", "-dv", out],
      [out, "--selftest"],
    ])
  })

  test("darwin-x64 on an arm64 host with no Rosetta skips the selftest", async () => {
    sources(["main.swift"])
    const { deps, calls } = fakeDeps()
    const r = await buildComputerUseHelper(req("darwin-x64"), deps)
    expect(r).toMatchObject({ kind: "built", id: "darwin-x64", arch: "x86_64" })
    if (r.kind !== "built") throw new Error("not built")
    expect(r.selftest).toBe("selftest skipped (x86_64 cannot run on this darwin-arm64 host)")
    expect(calls.map((c) => c[1])).toEqual(["swiftc", "--verify", "-dv"])
    expect(calls[0]?.[4]).toBe("x86_64-apple-macos14")
  })

  test("darwin-x64 on an arm64 host with Rosetta runs the selftest", async () => {
    sources(["main.swift"])
    const { deps, calls } = fakeDeps({ rosetta: () => true })
    const r = await buildComputerUseHelper(req("darwin-x64"), deps)
    expect(r).toMatchObject({ kind: "built", selftest: "selftest: 79/79 passed" })
    expect(calls.at(-1)?.[1]).toBe("--selftest")
  })

  test("no sources or no toolchain: dev gives missing, release fails", async () => {
    const { deps, calls } = fakeDeps({ toolchainGap: () => "xcrun is not on PATH" })
    expect(await buildComputerUseHelper(req("darwin-arm64"), deps)).toEqual({
      kind: "missing",
      reason: `no Swift sources in ${join(plugins, HELPER_PACKAGE, "native", "Sources")}`,
    })
    await expect(buildComputerUseHelper(req("darwin-arm64", "release"), deps)).rejects.toThrow(
      /no Swift sources .* A release must embed the helper/,
    )
    sources(["main.swift"])
    expect(await buildComputerUseHelper(req("darwin-arm64"), deps)).toEqual({
      kind: "missing",
      reason: "xcrun is not on PATH",
    })
    await expect(buildComputerUseHelper(req("darwin-x64", "release"), deps)).rejects.toThrow(
      HelperBuildError,
    )
    expect(calls).toEqual([])
  })

  for (const step of ["swiftc", "--verify", "-dv", "--selftest"]) {
    test(`a failed ${step} fails the build in dev mode too`, async () => {
      sources(["main.swift"])
      const { deps } = fakeDeps({ fail: step })
      await expect(buildComputerUseHelper(req("darwin-arm64"), deps)).rejects.toThrow(
        /failed \(exit 1\)\nboom/,
      )
    })
  }

  test("a selftest with a failed check fails the build", async () => {
    sources(["main.swift"])
    const base = fakeDeps().deps
    const run: Runner = async (cmd, ms) =>
      cmd[1] === "--selftest" ? { exitCode: 0, out: "selftest: 1/2 passed" } : base.run(cmd, ms)
    await expect(buildComputerUseHelper(req("darwin-arm64"), { ...base, run })).rejects.toThrow(
      /printed no "selftest: N\/N passed" line/,
    )
  })

  test("the embed key is the one the plugin reads", () => {
    expect(HELPER_PACKAGE).toBe("ma-computer-use-plugin")
    expect(HELPER_KEY).toBe("native/build/ComputerUseHelper")
  })
})
