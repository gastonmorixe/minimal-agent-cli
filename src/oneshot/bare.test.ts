import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AGENTS_MD_PLUGIN_ID,
  type BareManifest,
  bareDisableIds,
  bareManifestOf,
  planBare,
  readBareFlag,
  readPluginManifests,
} from "./bare.ts"

const manifests: BareManifest[] = [
  { id: "agents-md", toolNames: [], hostModeIds: [] },
  { id: "ma-fetch", toolNames: ["Fetch"], hostModeIds: [] },
  { id: "tasks", toolNames: ["Task"], hostModeIds: [] },
  { id: "memory", toolNames: ["MemoryTool"], hostModeIds: [] },
  { id: "acp", toolNames: [], hostModeIds: ["acp"] },
]

describe("readBareFlag", () => {
  test("--bare present / absent", () => {
    expect(readBareFlag(["--bare", "-p", "hi"])).toBe(true)
    expect(readBareFlag(["-p", "hi"])).toBe(false)
  })
})

describe("planBare", () => {
  test("off: empty plan, the run does not change", () => {
    expect(planBare({ bare: false, manifests, toolPolicy: null })).toEqual({
      disable: [],
      keep: [],
    })
  })

  test("on, no --tools: every manifest plugin is disabled", () => {
    const plan = planBare({ bare: true, manifests, toolPolicy: null })
    expect(plan.disable).toEqual(["acp", "agents-md", "ma-fetch", "memory", "tasks"])
    expect(plan.keep).toEqual([])
  })

  test("AGENTS.md is skipped even with no agents-md manifest", () => {
    const plan = planBare({ bare: true, manifests: [], toolPolicy: null })
    expect(plan.disable).toEqual([AGENTS_MD_PLUGIN_ID])
  })

  test("a requested tool keeps its plugin", () => {
    const plan = planBare({
      bare: true,
      manifests,
      toolPolicy: { kind: "allow-list", tools: ["Fetch", "Read"] },
    })
    expect(plan.keep).toEqual([{ id: "ma-fetch", reason: "tool Fetch" }])
    expect(plan.disable).not.toContain("ma-fetch")
    expect(plan.disable).toContain("tasks")
  })

  test("--host-mode keeps its plugin, --enable-plugin keeps the named plugin", () => {
    const plan = planBare({
      bare: true,
      manifests,
      toolPolicy: { kind: "deny-all" },
      hostModeId: "acp",
      explicitEnable: ["memory"],
    })
    expect(plan.keep.map((k) => k.id)).toEqual(["acp", "memory"])
    expect(plan.disable).toEqual(["agents-md", "ma-fetch", "tasks"])
  })

  test("agents-md stays off even when --enable-plugin names it", () => {
    const plan = planBare({
      bare: true,
      manifests,
      toolPolicy: null,
      explicitEnable: [AGENTS_MD_PLUGIN_ID],
    })
    expect(plan.disable).toContain(AGENTS_MD_PLUGIN_ID)
  })
})

describe("bareManifestOf", () => {
  test("raw, prefixed, alias tool names and host modes", () => {
    const m = bareManifestOf({
      id: "diff-view",
      name: "Diff Viewer",
      headless: {
        tools: [
          { trigger: { type: "tool", tool: { name: "ShowDiff", aliases: ["show_diff"] } } },
          { trigger: { type: "inline_tag", tag: "diff" } },
        ],
        hostModes: [{ id: "x" }],
      },
    })
    expect(m?.toolNames).toEqual(["ShowDiff", "DiffViewerShowDiff", "show_diff"])
    expect(m?.hostModeIds).toEqual(["x"])
  })

  test("explicitName keeps the raw name only, no id gives undefined", () => {
    const m = bareManifestOf({
      id: "memory",
      name: "Memory",
      headless: {
        tools: [{ trigger: { type: "tool", tool: { name: "MemoryTool", explicitName: true } } }],
      },
    })
    expect(m?.toolNames).toEqual(["MemoryTool"])
    expect(bareManifestOf({ name: "x" })).toBeUndefined()
    expect(bareManifestOf(null)).toBeUndefined()
  })
})

describe("modes stay (review P0-1)", () => {
  // The real ask-mode manifest shape (ma-ask-mode-plugin/manifest.json).
  const askMode = {
    id: "ask-mode",
    name: "Ask Mode",
    headless: {
      modes: [{ id: "ask", label: "ask", permissions: { deny: ["Edit", "Write"] } }],
    },
  }

  test("bareManifestOf reads headless.modes[].id", () => {
    expect(bareManifestOf(askMode)?.modeIds).toEqual(["ask"])
    expect(bareManifestOf({ id: "x" })?.modeIds).toEqual([])
  })

  test("--bare keeps every plugin that owns a mode, so ask stays the default", () => {
    const m = bareManifestOf(askMode)
    if (m === undefined) throw new Error("no manifest")
    const plan = planBare({ bare: true, manifests: [...manifests, m], toolPolicy: null })
    expect(plan.disable).not.toContain("ask-mode")
    expect(plan.keep).toEqual([{ id: "ask-mode", reason: "mode ask" }])
  })

  test("bareDisableIds on a real root keeps ask-mode", () => {
    const root = mkdtempSync(join(tmpdir(), "bare-modes-"))
    mkdirSync(join(root, "ask-mode"))
    writeFileSync(join(root, "ask-mode", "manifest.json"), JSON.stringify(askMode))
    mkdirSync(join(root, "a"))
    writeFileSync(join(root, "a", "manifest.json"), JSON.stringify({ id: "a" }))
    const on = { bare: true, cliToolFilter: null, hostModeId: undefined }
    expect(bareDisableIds(on, { embedded: [root] }, [])).toEqual(["a", "agents-md"])
  })
})

describe("readPluginManifests", () => {
  test("reads manifests one level under each root, skips bad ones and missing roots", () => {
    const root = mkdtempSync(join(tmpdir(), "bare-test-"))
    mkdirSync(join(root, "a"))
    writeFileSync(join(root, "a", "manifest.json"), JSON.stringify({ id: "a", name: "A" }))
    mkdirSync(join(root, "b"))
    writeFileSync(join(root, "b", "manifest.json"), "{not json")
    mkdirSync(join(root, "c"))
    const got = readPluginManifests({ embedded: [root], user: [join(root, "missing")] })
    expect(got.map((m) => m.id)).toEqual(["a"])
  })
})

describe("bareDisableIds", () => {
  test("off: empty list. On: --enable-plugin from argv keeps the plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "bare-ids-"))
    for (const id of ["a", "b"]) {
      mkdirSync(join(root, id))
      writeFileSync(join(root, id, "manifest.json"), JSON.stringify({ id }))
    }
    const opts = { bare: false, cliToolFilter: null, hostModeId: undefined }
    expect(bareDisableIds(opts, { embedded: [root] }, [])).toEqual([])
    const on = { ...opts, bare: true }
    expect(bareDisableIds(on, { embedded: [root] }, ["--enable-plugin", "b"])).toEqual([
      "a",
      "agents-md",
    ])
  })

  test("--dry-run and MINIMAL_AGENT_DRY_RUN=1 keep the dry-run plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "bare-dry-"))
    for (const id of ["a", "dry-run"]) {
      mkdirSync(join(root, id))
      writeFileSync(join(root, id, "manifest.json"), JSON.stringify({ id }))
    }
    const on = { bare: true, cliToolFilter: null, hostModeId: undefined }
    expect(bareDisableIds(on, { embedded: [root] }, [])).toEqual(["a", "agents-md", "dry-run"])
    expect(bareDisableIds(on, { embedded: [root] }, ["--dry-run"])).toEqual(["a", "agents-md"])
    expect(bareDisableIds(on, { embedded: [root] }, [], { MINIMAL_AGENT_DRY_RUN: "1" })).toEqual([
      "a",
      "agents-md",
    ])
  })
})
