import { describe, expect, test } from "bun:test"

import { builtinRegistry } from "./index.ts"
import { SUBAGENT_INHERITANCE } from "./subagent-inheritance.ts"

const flagNames = builtinRegistry().globalFlags.map((f) => f.name)
const entries = Object.entries(SUBAGENT_INHERITANCE)
const namesWith = (label: string) =>
  entries
    .filter(([, e]) => e.label === label)
    .map(([n]) => n)
    .sort()

const PARTS = [
  "system-prompt",
  "system-identity",
  "system-instructions",
  "system-loop-safety",
  "system-tool-output-conventions",
  "system-session-context",
  "provider-system-preamble",
]

/** Flags that feed the StartupProfile fields (SPEC 4.1, R1 to R5). */
const STARTUP_PROFILE_FLAGS = [
  // systemPrompt
  ...PARTS.flatMap((p) => [p, `${p}-file`, `no-${p}`]),
  "unsafe-system-prompt-overrides",
  // noAgentsMd
  "no-agents-md",
  // pluginPrompts
  "no-plugin-prompts",
  "plugin-prompts",
  "no-plugin-prompts-for",
  "plugin-prompts-for",
  // plugins
  "disable-plugin",
  "enable-plugin",
  // bare
  "bare",
].sort()

/** Flags the spawn plan clamps for the worker (SPEC R6, R7). */
const WORKER_CLAMP_FLAGS = [
  "tools",
  "no-tools",
  "mode",
  "model",
  "provider",
  "effort",
  "credential-name",
].sort()

describe("subagent inheritance labels (SPEC T7)", () => {
  test("every global flag has a label", () => {
    expect(flagNames.filter((n) => !(n in SUBAGENT_INHERITANCE))).toEqual([])
  })

  test("no label names a flag that does not exist", () => {
    const known = new Set(flagNames)
    expect(entries.map(([n]) => n).filter((n) => !known.has(n))).toEqual([])
  })

  test("every no-inherit label has a reason", () => {
    const bad = entries
      .filter(([, e]) => e.label === "no-inherit" && (e.reason ?? "").trim() === "")
      .map(([n]) => n)
    expect(bad).toEqual([])
  })

  test("the inherit set matches the StartupProfile flags", () => {
    expect(namesWith("inherit")).toEqual(STARTUP_PROFILE_FLAGS)
  })

  test("the worker-clamp set matches the spawn plan clamps", () => {
    expect(namesWith("worker-clamp")).toEqual(WORKER_CLAMP_FLAGS)
  })
})
