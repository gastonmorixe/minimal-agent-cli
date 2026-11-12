import { describe, expect, test } from "bun:test"

import { fakeGithub, makeBuild, makeDeps, makeRelease } from "../test-utils/update-fakes.ts"
import { UPDATE_EXIT } from "../update/run.ts"
import { isUpdateRequest, parseUpdateArgs, runUpdateCommand, UpdateArgError } from "./update.ts"

function sink() {
  const out: string[] = []
  return { out, write: (s: string) => out.push(s) }
}

describe("parseUpdateArgs", () => {
  test("defaults and every flag", () => {
    expect(parseUpdateArgs(["update"])).toEqual({
      check: false,
      rollback: false,
      channel: "stable",
      json: false,
    })
    expect(parseUpdateArgs(["update", "--check", "--channel", "nightly", "--json"])).toEqual({
      check: true,
      rollback: false,
      channel: "nightly",
      json: true,
    })
    expect(parseUpdateArgs(["update", "--to=0.2.0"]).to).toBe("0.2.0")
    expect(parseUpdateArgs(["update", "--to", "v0.2.0-nightly.20261112T061700Z"]).channel).toBe(
      "nightly",
    )
    expect(parseUpdateArgs(["update", "--output-format", "json"]).json).toBe(true)
  })

  test("errors", () => {
    expect(() => parseUpdateArgs(["update", "--channel", "beta"])).toThrow(UpdateArgError)
    expect(() => parseUpdateArgs(["update", "--to"])).toThrow(UpdateArgError)
    expect(() => parseUpdateArgs(["update", "--bogus"])).toThrow(UpdateArgError)
    expect(() => parseUpdateArgs(["update", "extra"])).toThrow(UpdateArgError)
    expect(() => parseUpdateArgs(["update", "--rollback", "--check"])).toThrow(UpdateArgError)
  })

  test("update --help stays with help", () => {
    expect(isUpdateRequest(["update"])).toBe(true)
    expect(isUpdateRequest(["update", "--check"])).toBe(true)
    expect(isUpdateRequest(["update", "--help"])).toBe(false)
    expect(isUpdateRequest(["help", "update"])).toBe(false)
    expect(isUpdateRequest(["fix", "update"])).toBe(false)
  })
})

describe("runUpdateCommand", () => {
  test("bad args: exit 2 on stderr", async () => {
    const stdout = sink()
    const stderr = sink()
    const code = await runUpdateCommand(["update", "--nope"], {}, { stdout, stderr }, makeDeps())
    expect(code).toBe(UPDATE_EXIT.usage)
    expect(stderr.out.join("")).toContain("unknown argument for update: --nope")
  })

  test("--check with an update: exit 10 on stdout", async () => {
    const stdout = sink()
    const stderr = sink()
    const deps = makeDeps({ fetch: fakeGithub({ releases: [makeRelease({ tag: "v0.2.0" })] }) })
    const code = await runUpdateCommand(["update", "--check"], {}, { stdout, stderr }, deps)
    expect(code).toBe(10)
    expect(stdout.out.join("")).toContain("update available: 0.1.0")
  })

  test("a failure goes to stderr with an update: prefix; JSON goes to stdout", async () => {
    const stdout = sink()
    const stderr = sink()
    const deps = makeDeps()
    expect(await runUpdateCommand(["update", "--check"], {}, { stdout, stderr }, deps)).toBe(4)
    expect(stderr.out.join("")).toMatch(/^update: no stable release found/u)

    const jsonOut = sink()
    const code = await runUpdateCommand(
      ["update", "--check", "--json"],
      {},
      { stdout: jsonOut, stderr },
      deps,
    )
    expect(code).toBe(4)
    const obj = JSON.parse(jsonOut.out.join(""))
    expect(obj).toMatchObject({ status: "no-release", exitCode: 4, channel: "stable" })
  })

  test("source mode JSON", async () => {
    const stdout = sink()
    const deps = makeDeps({ build: makeBuild({ mode: "source" }), standalone: false })
    const code = await runUpdateCommand(["update", "--json"], {}, { stdout, stderr: sink() }, deps)
    expect(code).toBe(0)
    expect(JSON.parse(stdout.out.join(""))).toMatchObject({ status: "source", exitCode: 0 })
  })
})
