/**
 * Snapshot pins of the root help (SPEC-HELP M-2, M-7, V-1, V-3).
 *
 * M-2 recorded the help bytes before the renderer read a width or
 * `NO_COLOR`. M-7 changed that on purpose: root help now wraps to the
 * resolved width and writes no SGR when `NO_COLOR` is set, so the 80 and 120
 * column snapshots differ and carry no escapes.
 *
 * Choice: keep any ANSI in the snapshot. The output is the exact bytes that
 * `printHelp` writes, so a change to color, to the escape codes, or to the
 * `NO_COLOR` policy shows as a snapshot diff. Stripping ANSI would hide that
 * drift. Each ESC byte is written as the visible text `<ESC>`. That swap is
 * one to one, so it hides nothing.
 *
 * One value is masked: the version on the title line. It comes from the
 * installed core `package.json` and changes on every release, which is not
 * help drift. A separate test checks that the title line has the real
 * version, so the mask cannot hide a lost version.
 *
 * The source is `printHelp` with a collector stream and an explicit env, so
 * the result does not depend on the terminal that runs the tests. The CLI
 * path (`--help` in src/startup/entry-args.ts) calls the same function with
 * `process.stdout` and `process.env`.
 *
 * @module startup/help.snapshot.test
 */

import { describe, expect, test } from "bun:test"

import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"
import { displayWidth, stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { type PrintHelpOptions, printHelp } from "./help.ts"

const VERSION_MASK = "v<AGENT_VERSION>"

/** The exact bytes `printHelp` writes to a stream with this TTY state. */
function helpBytes(
  env: Record<string, string>,
  isTTY = false,
  opts: PrintHelpOptions = {},
): string {
  let out = ""
  printHelp(
    {
      isTTY,
      write(s: string): boolean {
        out += s
        return true
      },
    },
    { env, ...opts },
  )
  return out
}

/** Make ESC visible and mask the release version. Nothing else changes. */
function forSnapshot(bytes: string): string {
  return bytes.replaceAll("\u001b", "<ESC>").replace(`v${AGENT_VERSION}`, VERSION_MASK)
}

function maxLineWidth(bytes: string): number {
  return Math.max(...bytes.split("\n").map(displayWidth))
}

/**
 * Lines wider than `width` that hold more than one token. SPEC-HELP V-2
 * allows a line over the width only when it is one unbreakable token.
 */
function overWidthMultiToken(bytes: string, width: number): string[] {
  return bytes
    .split("\n")
    .filter((l) => displayWidth(l) > width)
    .filter((l) => stripAnsi(l).trim().split(/\s+/u).length !== 1)
}

/**
 * The SGR styles still open at the end of `line`, when the line starts with
 * no style. A non-empty result means the style leaks into the next line.
 */
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
      else if (n === 4) open.add("underline")
      else if (n === 24) open.delete("underline")
      else if (n === 39) open.delete("fg")
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) open.add("fg")
      else if (n === 38) {
        open.add("fg")
        // Skip the 5;n or 2;r;g;b arguments of an extended color.
        i += params[i + 1] === "5" ? 2 : 4
      }
    }
  }
  return [...open]
}

describe("root help snapshot", () => {
  test("COLUMNS=80, NO_COLOR=1: wrapped to 80, no color", () => {
    expect(forSnapshot(helpBytes({ COLUMNS: "80", NO_COLOR: "1" }))).toMatchSnapshot()
  })

  test("COLUMNS=120, NO_COLOR=1: wrapped to 120, no color", () => {
    expect(forSnapshot(helpBytes({ COLUMNS: "120", NO_COLOR: "1" }))).toMatchSnapshot()
  })

  test("the version mask covers the real version once", () => {
    const bytes = helpBytes({ COLUMNS: "80", NO_COLOR: "1" })
    expect(bytes.split(`v${AGENT_VERSION}`).length).toBe(2)
    expect(bytes).not.toContain("<ESC>")
    expect(bytes).not.toContain(VERSION_MASK)
  })
})

describe("root help width (SPEC-HELP R-28, V-2)", () => {
  for (const columns of [20, 40, 60, 80, 120]) {
    test(`no line is wider than COLUMNS=${columns} except a single-token line, with and without color`, () => {
      for (const isTTY of [false, true]) {
        const bytes = helpBytes({ COLUMNS: String(columns), TERM: "xterm" }, isTTY)
        expect(overWidthMultiToken(bytes, columns)).toEqual([])
      }
    })
  }

  test("at COLUMNS 80 and 120 no line is wider than the width", () => {
    for (const columns of [80, 120]) {
      expect(maxLineWidth(helpBytes({ COLUMNS: String(columns) }))).toBeLessThanOrEqual(columns)
      expect(maxLineWidth(helpBytes({ COLUMNS: String(columns) }, true))).toBeLessThanOrEqual(
        columns,
      )
    }
  })

  test("a long token is not cut: the word list does not depend on the width", () => {
    const words = (bytes: string): string[] => stripAnsi(bytes).split(/\s+/u).filter(Boolean)
    const wide = words(helpBytes({ COLUMNS: "400" }))
    for (const columns of [20, 40, 60]) {
      expect(words(helpBytes({ COLUMNS: String(columns) }))).toEqual(wide)
    }
    const narrow = helpBytes({ COLUMNS: "20" }).split("\n")
    expect(narrow).toContain("    github.com/gastonmorixe/minimal-agent")
  })

  test("the explicit columns option wins over COLUMNS", () => {
    const bytes = helpBytes({ COLUMNS: "200" }, false, { columns: 70 })
    expect(bytes).toBe(helpBytes({ COLUMNS: "70" }))
    expect(overWidthMultiToken(bytes, 70)).toEqual([])
  })
})

describe("root help color (SPEC-HELP R-29, V-3)", () => {
  const SGR = /\u001b\[/u

  test("a TTY with a clean env gets color", () => {
    expect(helpBytes({ COLUMNS: "80", TERM: "xterm-256color" }, true)).toMatch(SGR)
  })

  test("NO_COLOR=1 on a TTY gives 0 SGR sequences", () => {
    expect(helpBytes({ COLUMNS: "80", NO_COLOR: "1" }, true)).not.toMatch(SGR)
  })

  test("a non-TTY stream gives 0 SGR sequences", () => {
    expect(helpBytes({ COLUMNS: "80" }, false)).not.toMatch(SGR)
  })

  test("TERM=dumb on a TTY gives 0 SGR sequences", () => {
    expect(helpBytes({ COLUMNS: "80", TERM: "dumb" }, true)).not.toMatch(SGR)
  })

  test("--no-color on a TTY gives 0 SGR sequences", () => {
    expect(helpBytes({ COLUMNS: "80" }, true, { noColor: true })).not.toMatch(SGR)
  })

  for (const columns of [40, 80, 120]) {
    test(`COLUMNS=${columns}: no colored line ends with an open style`, () => {
      const lines = helpBytes({ COLUMNS: String(columns), TERM: "xterm" }, true).split("\n")
      expect(lines.some((l) => SGR.test(l))).toBe(true)
      const leaks = lines.filter((l) => openStylesAtEnd(l).length > 0)
      expect(leaks).toEqual([])
    })
  }

  test("the open-style scan finds a leak", () => {
    expect(openStylesAtEnd("\u001b[2mdim")).toEqual(["dim"])
    expect(openStylesAtEnd("\u001b[1;38;5;45mx\u001b[22m")).toEqual(["fg"])
    expect(openStylesAtEnd("\u001b[2;37mx\u001b[0m")).toEqual([])
  })

  test("color and plain output have the same visible text", () => {
    const plain = helpBytes({ COLUMNS: "80" }, false)
    const colored = helpBytes({ COLUMNS: "80" }, true)
    expect(colored.replaceAll(/\u001b\[[0-9;]*m/gu, "")).toBe(plain)
  })
})
