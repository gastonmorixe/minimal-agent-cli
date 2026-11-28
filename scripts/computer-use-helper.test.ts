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
import { dirname, join } from "node:path"

import {
  buildComputerUseHelper,
  canRunOnHost,
  codesignFlags,
  HELPER_KEY,
  HELPER_PACKAGE,
  type HelperBuildDeps,
  HelperBuildError,
  helperInfo,
  helperLogLine,
  helperOutDir,
  helperSources,
  NO_HELPER_ENV,
  noHelperRequested,
  type Runner,
  selftestSummary,
  swiftArchOf,
  swiftcCandidates,
  swiftcCommand,
  type ToolchainProbe,
  toolchainGap,
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

describe("toolchainGap", () => {
  const XCODE = "/Applications/Xcode-27.2.0.app/Contents/Developer"
  const CLT = "/Library/Developer/CommandLineTools"
  const XCODE_SWIFTC = `${XCODE}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`
  const CLT_SWIFTC = `${CLT}/usr/bin/swiftc`

  /** A fake host with only `files` on disk. `calls` records each probe step. */
  function probe(
    files: readonly string[],
    over: Partial<ToolchainProbe> = {},
  ): { probe: ToolchainProbe; calls: string[] } {
    const calls: string[] = []
    const disk = new Set(files)
    return {
      probe: {
        platform: "darwin",
        which: (cmd) => {
          calls.push(`which ${cmd}`)
          return cmd === "xcrun" ? "/usr/bin/xcrun" : null
        },
        developerDir: undefined,
        xcodeSelect: () => {
          calls.push("xcode-select -p")
          return XCODE
        },
        exists: (path) => {
          calls.push(`exists ${path}`)
          return disk.has(path)
        },
        ...over,
      },
      calls,
    }
  }

  test("the swiftc paths: the Xcode default toolchain, then usr/bin", () => {
    expect(swiftcCandidates(XCODE)).toEqual([XCODE_SWIFTC, `${XCODE}/usr/bin/swiftc`])
    expect(swiftcCandidates(CLT)).toEqual([
      `${CLT}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`,
      CLT_SWIFTC,
    ])
  })

  test("an Xcode dir with swiftc in its default toolchain is a toolchain", () => {
    expect(toolchainGap(probe([XCODE_SWIFTC]).probe)).toBeUndefined()
  })

  test("the Command Line Tools dir with usr/bin/swiftc is a toolchain", () => {
    expect(toolchainGap(probe([CLT_SWIFTC], { xcodeSelect: () => CLT }).probe)).toBeUndefined()
  })

  test("no swiftc at either path is no toolchain, and nothing runs xcrun", async () => {
    const { probe: p, calls } = probe([])
    const gap = toolchainGap(p)
    expect(gap).toBe(
      `no swiftc under ${XCODE} (from xcode-select -p), so no Xcode or Command Line Tools`,
    )
    expect(calls).toEqual([
      "which xcrun",
      "xcode-select -p",
      `exists ${XCODE_SWIFTC}`,
      `exists ${XCODE}/usr/bin/swiftc`,
    ])
    // The build gets the gap and runs no command: no `xcrun swiftc`.
    sources(["main.swift"])
    const ran: string[][] = []
    const deps: HelperBuildDeps = {
      run: async (cmd) => {
        ran.push(cmd)
        return { exitCode: 0, out: "" }
      },
      toolchainGap: () => toolchainGap(p),
      host: { platform: "darwin", arch: "arm64" },
      rosetta: () => false,
    }
    const req = { target: "darwin-arm64", pluginsDir: plugins, outRoot }
    expect(await buildComputerUseHelper({ ...req, mode: "dev" }, deps)).toEqual({
      kind: "missing",
      reason: gap as string,
    })
    await expect(buildComputerUseHelper({ ...req, mode: "release" }, deps)).rejects.toThrow(
      /no swiftc under .* A release must embed the helper/,
    )
    expect(ran).toEqual([])
  })

  test("DEVELOPER_DIR wins over xcode-select, and a stale one is no toolchain", () => {
    const stale = probe([XCODE_SWIFTC], {
      developerDir: "/Applications/Gone.app/Contents/Developer",
    })
    expect(toolchainGap(stale.probe)).toMatch(
      /^no swiftc under \/Applications\/Gone.* DEVELOPER_DIR/,
    )
    expect(stale.calls).not.toContain("xcode-select -p")
    expect(toolchainGap(probe([XCODE_SWIFTC], { developerDir: XCODE }).probe)).toBeUndefined()
    // xcrun also takes the app bundle path: it reads Contents/Developer.
    const app = probe([XCODE_SWIFTC], { developerDir: "/Applications/Xcode-27.2.0.app" })
    expect(toolchainGap(app.probe)).toBeUndefined()
  })

  test("no macOS host, no xcrun, or a failed xcode-select -p is no toolchain", () => {
    expect(toolchainGap(probe([XCODE_SWIFTC], { platform: "linux" }).probe)).toBe(
      "swiftc needs a macOS host, this host is linux",
    )
    expect(toolchainGap(probe([XCODE_SWIFTC], { which: () => null }).probe)).toBe(
      "xcrun is not on PATH",
    )
    expect(toolchainGap(probe([XCODE_SWIFTC], { xcodeSelect: () => undefined }).probe)).toBe(
      "no Xcode or Command Line Tools (xcode-select -p failed)",
    )
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
      selftest: "passed",
      checks: "79/79",
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
    expect(r.selftest).toBe("skipped: x86_64 cannot run on this darwin-arm64 host")
    expect(r.checks).toBeUndefined()
    expect(calls.map((c) => c[1])).toEqual(["swiftc", "--verify", "-dv"])
    expect(calls[0]?.[4]).toBe("x86_64-apple-macos14")
  })

  test("darwin-x64 on an arm64 host with Rosetta runs the selftest", async () => {
    sources(["main.swift"])
    const { deps, calls } = fakeDeps({ rosetta: () => true })
    const r = await buildComputerUseHelper(req("darwin-x64"), deps)
    expect(r).toMatchObject({ kind: "built", selftest: "passed", checks: "79/79" })
    expect(calls.at(-1)?.[1]).toBe("--selftest")
  })

  test("the selftest status goes to the log line and to the build info", async () => {
    sources(["main.swift"])
    const passed = await buildComputerUseHelper(req("darwin-arm64"), fakeDeps().deps)
    const skipped = await buildComputerUseHelper(req("darwin-x64"), fakeDeps().deps)
    expect(helperInfo(passed)).toEqual({ helperSelftest: "passed" })
    expect(helperInfo(skipped)).toEqual({
      helperSelftest: "skipped: x86_64 cannot run on this darwin-arm64 host",
    })
    expect(helperLogLine(passed)).toBe(
      `computer-use helper darwin-arm64 arm64 5 bytes, codesign flags=0x20002(adhoc,linker-signed), ` +
        `selftest passed (79/79) -> ${join(outRoot, "darwin-arm64", "ComputerUseHelper")}`,
    )
    expect(helperLogLine(skipped)).toContain(
      ", selftest skipped: x86_64 cannot run on this darwin-arm64 host -> ",
    )
    // No helper: no build info field, so the info shape stays the same as before.
    expect(helperInfo({ kind: "not-darwin" })).toEqual({})
    expect(helperInfo({ kind: "missing", reason: "x" })).toEqual({})
    expect(helperInfo({ kind: "skipped", reason: "x" })).toEqual({})
  })

  test("the output dir is the dir of the built file, so compile.ts can claim it first", async () => {
    sources(["main.swift"])
    const r = await buildComputerUseHelper(req("bun-darwin-arm64"), fakeDeps().deps)
    if (r.kind !== "built") throw new Error("not built")
    expect(helperOutDir(outRoot, "bun-darwin-arm64")).toBe(join(outRoot, "darwin-arm64"))
    expect(helperOutDir(outRoot, "darwin-arm64")).toBe(dirname(r.path))
    expect(helperOutDir(outRoot, "linux-x64")).toBeUndefined()
  })

  test("MA_COMPILE_NO_HELPER=1: dev skips the helper, release ignores it", async () => {
    sources(["main.swift"])
    expect(NO_HELPER_ENV).toBe("MA_COMPILE_NO_HELPER")
    expect(noHelperRequested({ MA_COMPILE_NO_HELPER: "1" })).toBe(true)
    expect(noHelperRequested({ MA_COMPILE_NO_HELPER: "0" })).toBe(false)
    expect(noHelperRequested({ MA_COMPILE_NO_HELPER: "" })).toBe(false)
    expect(noHelperRequested({})).toBe(false)
    const dev = fakeDeps()
    expect(
      await buildComputerUseHelper({ ...req("darwin-arm64"), noHelper: true }, dev.deps),
    ).toEqual({ kind: "skipped", reason: "MA_COMPILE_NO_HELPER=1" })
    expect(dev.calls).toEqual([])
    expect(existsSync(outRoot)).toBe(false)
    const release = fakeDeps()
    const r = await buildComputerUseHelper(
      { ...req("darwin-arm64", "release"), noHelper: true },
      release.deps,
    )
    expect(r).toMatchObject({ kind: "built", selftest: "passed" })
    expect(release.calls[0]?.[1]).toBe("swiftc")
    // Release with no toolchain still fails, also with the opt-out set.
    const gap = fakeDeps({ toolchainGap: () => "xcrun is not on PATH" })
    await expect(
      buildComputerUseHelper({ ...req("darwin-arm64", "release"), noHelper: true }, gap.deps),
    ).rejects.toThrow(/xcrun is not on PATH\. A release must embed the helper/)
    // A linux target is not-darwin first, with or without the opt-out.
    expect(await buildComputerUseHelper({ ...req("linux-x64"), noHelper: true }, dev.deps)).toEqual(
      { kind: "not-darwin" },
    )
  })

  test("a command that cannot start gives a HelperBuildError with exit 127", async () => {
    sources(["main.swift"])
    const base = fakeDeps().deps
    // The same error as Bun.spawn of a missing command (Bun 1.4.5).
    const enoent = Object.assign(new Error('Executable not found in $PATH: "codesign"'), {
      code: "ENOENT",
    })
    const run: Runner = async (cmd, ms) => {
      if (cmd[0] === "codesign") throw enoent
      return base.run(cmd, ms)
    }
    const err = await buildComputerUseHelper(req("darwin-arm64"), { ...base, run }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HelperBuildError)
    expect((err as Error).message).toBe(
      "computer-use helper for darwin-arm64: codesign --verify --strict failed (exit 127)\n" +
        'cannot start codesign: Executable not found in $PATH: "codesign"',
    )
    // A throw at the first step (swiftc through xcrun) gives the same form.
    const none: Runner = async () => {
      throw enoent
    }
    await expect(
      buildComputerUseHelper(req("darwin-arm64"), { ...base, run: none }),
    ).rejects.toThrow(/: swiftc failed \(exit 127\)\ncannot start xcrun: /)
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
