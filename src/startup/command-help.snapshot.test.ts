/**
 * Snapshot, width, and color pins of command help (SPEC-HELP 8.5, V-1, V-2,
 * V-3, plan M-9b).
 *
 * The source is the help model of each visible registry path, rendered by
 * `renderModel` with the policy that `resolveHelpPolicy` gives for an
 * explicit env and TTY state. So the result does not depend on the terminal
 * that runs the tests. M-9c wires the same pair into `--help`.
 *
 * One `describe` per path keeps a snapshot diff easy to place (plan K-2).
 * The program version is not in command help, so nothing is masked. Each
 * ESC byte would show as `<ESC>`, but NO_COLOR snapshots must hold none.
 *
 * @module startup/command-help.snapshot.test
 */

import { describe, expect, test } from "bun:test"

import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { builtinRegistry } from "../cli/registry/index.ts"
import { buildHelpModel, visibleCommandPaths } from "../ui/help/model.ts"
import { resolveHelpPolicy } from "../ui/help/policy.ts"
import { renderModel } from "../ui/help/render-model.ts"

const reg = builtinRegistry()
const PATHS = visibleCommandPaths(reg)
const SGR = /\u001b\[/u

/** The bytes of command help for `path`, as a help stream would get them. */
function commandHelpBytes(
  path: readonly string[],
  env: Record<string, string>,
  isTTY = false,
): string {
  const policy = resolveHelpPolicy({ env, isTTY })
  return `${renderModel(buildHelpModel(reg, { path }), policy).join("\n")}\n`
}

function forSnapshot(bytes: string): string {
  return bytes.replaceAll("\u001b", "<ESC>")
}

/** Lines wider than `width` that hold more than one token (V-2 allows one token). */
function overWidthMultiToken(bytes: string, width: number): string[] {
  return bytes
    .split("\n")
    .filter((l) => displayWidth(l) > width)
    .filter((l) => stripAnsi(l).trim().split(/\s+/u).length !== 1)
}

/** The SGR styles still open at the end of `line`, when it starts with no style. */
function openStylesAtEnd(line: string): string[] {
  const open = new Set<string>()
  for (const m of line.matchAll(/\u001b\[([0-9;]*)m/gu)) {
    const params = m[1] === "" || m[1] === undefined ? ["0"] : m[1].split(";")
    for (let i = 0; i < params.length; i++) {
      const n = Number(params[i])
      if (n === 0) open.clear()
      else if (n === 22) {
        open.delete("bold")
        open.delete("dim")
      } else if (n === 1) open.add("bold")
      else if (n === 2) open.add("dim")
      else if (n === 3) open.add("italic")
      else if (n === 23) open.delete("italic")
      else if (n === 39) open.delete("fg")
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) open.add("fg")
      else if (n === 38) {
        open.add("fg")
        i += params[i + 1] === "5" ? 2 : 4
      }
    }
  }
  return [...open]
}

test("the visible path list is not empty and holds no hidden command", () => {
  expect(PATHS.length).toBeGreaterThan(20)
  const names = PATHS.map((p) => p.join(" "))
  expect(names).toContain("sessions")
  expect(names).toContain("auth-status prune")
  expect(names).not.toContain("models")
  expect(names).not.toContain("models-live")
})

for (const path of PATHS) {
  const name = path.join(" ")

  describe(`command help: ${name}`, () => {
    test("COLUMNS=80, NO_COLOR=1", () => {
      const bytes = commandHelpBytes(path, { COLUMNS: "80", NO_COLOR: "1" })
      expect(bytes).not.toMatch(SGR)
      expect(forSnapshot(bytes)).toMatchSnapshot()
    })

    test("COLUMNS=120, NO_COLOR=1", () => {
      const bytes = commandHelpBytes(path, { COLUMNS: "120", NO_COLOR: "1" })
      expect(bytes).not.toMatch(SGR)
      expect(forSnapshot(bytes)).toMatchSnapshot()
    })

    test("has USAGE and the path in the header", () => {
      const lines = commandHelpBytes(path, { COLUMNS: "80" }).split("\n")
      expect(lines[0]).toBe(`  minimal-agent ${name}`)
      expect(lines).toContain("  USAGE")
    })

    test("width 60, 80, 120: no line wider than the width except a single-token line", () => {
      for (const columns of [60, 80, 120]) {
        for (const isTTY of [false, true]) {
          const bytes = commandHelpBytes(path, { COLUMNS: String(columns), TERM: "xterm" }, isTTY)
          expect(overWidthMultiToken(bytes, columns)).toEqual([])
        }
      }
    })

    test("0 SGR with NO_COLOR, with a non-TTY stream, and with TERM=dumb", () => {
      expect(commandHelpBytes(path, { COLUMNS: "80", NO_COLOR: "1" }, true)).not.toMatch(SGR)
      expect(commandHelpBytes(path, { COLUMNS: "80", TERM: "xterm" }, false)).not.toMatch(SGR)
      expect(commandHelpBytes(path, { COLUMNS: "80", TERM: "dumb" }, true)).not.toMatch(SGR)
    })

    test("colored: no line ends with an open style, same visible text as plain", () => {
      for (const columns of [60, 80, 120]) {
        const env = { COLUMNS: String(columns), TERM: "xterm-256color" }
        const colored = commandHelpBytes(path, env, true)
        expect(colored).toMatch(SGR)
        expect(colored.split("\n").filter((l) => openStylesAtEnd(l).length > 0)).toEqual([])
        expect(colored.replaceAll(/\u001b\[[0-9;]*m/gu, "")).toBe(
          commandHelpBytes(path, env, false),
        )
      }
    })
  })
}

describe("command help: hidden command by path", () => {
  test("models renders, and its parent list skips it", () => {
    const bytes = commandHelpBytes(["models"], { COLUMNS: "80", NO_COLOR: "1" })
    expect(bytes.split("\n")[0]).toBe("  minimal-agent models")
    expect(bytes).toContain("SEE ALSO")
  })
})
