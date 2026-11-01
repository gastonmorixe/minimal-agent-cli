/**
 * Golden tests for the CLI mode painters (`./mode-prompt.ts`).
 *
 * Core's `ModeManager` returns host-neutral color tokens. The CLI maps them
 * to SGR. `mode-prompt.golden.json` holds the exact bytes that core's old
 * SGR resolver made before the move (decision 26). Every case here must
 * render the same bytes as before.
 */

import { describe, expect, test } from "bun:test"
import { ModeManager } from "@minimal-agent/core/host-kit/modes"
import type { ManifestMode } from "@minimal-agent/core/plugin-api/types/plugin"

import type { StyleEnv } from "../../terminal-kit/mode-style.ts"
import golden from "./mode-prompt.golden.json"
import {
  modeLabelFgOpen,
  modePromptPrefix,
  modePromptPrefixForId,
  terminalModeStyle,
  terminalModeStyleForId,
} from "./mode-prompt.ts"

const MODES: ManifestMode[] = [
  { id: "ask", label: "ASK", style: { label: { fg: "blue" }, arrow: { fg: "blue" } } },
  { id: "legacy", label: "Legacy", color: "magenta" },
  {
    id: "hex",
    label: "HEX",
    style: { label: { fg: "#ff8800", bg: "#112233" }, status: { fg: "#00ff00", dim: true } },
  },
  {
    id: "obj",
    label: "OBJ",
    style: {
      label: { fg: { hex: "#010203", ansi256: 42, token: "danger" } },
      arrow: { fg: { ansi256: 99 } },
      status: { fg: { token: "muted" }, bold: true },
    },
  },
  { id: "objtok", style: { label: { fg: { token: "accent-soft" }, bg: { token: "gold" } } } },
  {
    id: "badhex",
    label: "BAD",
    style: { label: { fg: { hex: "#zz", ansi256: 7 } }, arrow: { fg: "#12" } },
  },
  {
    id: "sem",
    label: "SEM",
    style: {
      label: { fg: "accent", bg: "brand" },
      arrow: { fg: "danger", bold: false },
      status: { fg: "muted", bg: "transparent" },
    },
  },
  {
    id: "same",
    label: "SAME",
    style: { label: { fg: "red", bg: "red" }, arrow: { fg: { ansi256: 5 }, bg: { ansi256: 5 } } },
  },
  {
    id: "theme",
    label: "THEME",
    style: {
      label: { fg: "cyan" },
      theme: {
        light: { label: { fg: "purple", dim: true }, arrow: { fg: "lime" } },
        "high-contrast": { status: { fg: "sky" } },
      },
    },
  },
  { id: "plain", label: "PLAIN" },
  { id: "unknown", label: "UNK", style: { label: { fg: "nope" }, arrow: { fg: "transparent" } } },
  { id: "long", label: "verylonglabel", color: "orange" },
  { id: "cjk", label: "日本語日本語", color: "pink" },
  { id: "nolabel", color: "yellow" },
  {
    id: "proto",
    label: "PROTO",
    style: { label: { fg: "green" }, arrow: { fg: { token: "sky" } } },
  },
]
const ENVS: StyleEnv[] = [
  { theme: "dark", capability: "truecolor" },
  { theme: "light", capability: "ansi16" },
  { theme: "high-contrast", capability: "ansi256" },
].map((e) => e as StyleEnv)

const GOLDEN: Record<string, Record<string, unknown>> = golden

describe("mode painters render the same bytes as the old core resolver", () => {
  for (const env of ENVS) {
    const key = `${env.theme}/${env.capability}`
    const want = GOLDEN[key]
    test(`${key}: prompt prefix and resolved style for each mode id`, () => {
      const m = new ModeManager(MODES, null, env.theme)
      for (const id of [null, ...MODES.map((x) => x.id), "missing"]) {
        const got: unknown = {
          prefix: modePromptPrefixForId(m, id, "BASE ", "❯", env),
          prefixGlyph: modePromptPrefixForId(m, id, "BASE ", ">", env),
          resolved: terminalModeStyleForId(m, id, env),
        }
        expect(got).toEqual(want[String(id)])
      }
    })

    test(`${key}: active-mode prefix and status style`, () => {
      const m = new ModeManager(MODES, null, env.theme)
      for (const [id, row] of [
        ["ask", "active"],
        ["hex", "activeHex"],
      ]) {
        m.setMode(id)
        const resolved = terminalModeStyle(m.resolved(), env)
        const got: unknown = {
          prefix: modePromptPrefix(m, "BASE ", "❯", env),
          resolved,
          status: resolved?.status ?? null,
        }
        expect(got).toEqual(want[row])
      }
    })
  }

  test("modeLabelFgOpen gives the label foreground the chips use", () => {
    const env: StyleEnv = { theme: "dark", capability: "ansi16" }
    const m = new ModeManager(MODES, null, env.theme)
    expect(modeLabelFgOpen(m, null, env)).toBe("\x1b[38;5;199m")
    expect(modeLabelFgOpen(m, "ask", env)).toBe("\x1b[34m")
    expect(modeLabelFgOpen(m, "plain", env)).toBeNull()
    expect(modeLabelFgOpen(m, "missing", env)).toBeNull()
  })
})
