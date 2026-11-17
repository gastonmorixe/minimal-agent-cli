/**
 * Tests for `scripts/gen-embedded-plugins.ts`: a fixture plugins dir in,
 * the exact table module text out, and the table registers with core and
 * serves texts, modules, files and `__run` scripts.
 *
 * @module scripts/gen-embedded-plugins.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  clearEmbeddedPlugins,
  embeddedPluginPackages,
  findEmbeddedScript,
  registerEmbeddedPlugins,
} from "@minimal-agent/core/host-kit/embedded-plugins"

import {
  collectPackages,
  EmbedGenError,
  manifestRefs,
  renderEmbeddedPluginsModule,
  writeEmbeddedPluginsModule,
} from "./gen-embedded-plugins.ts"

let root: string

/** Write `files` (a map of rel path to text) under `root/<pkg>`. */
function pkg(name: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, name, rel)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, text)
  }
}

const FIXTURE_MANIFEST = {
  id: "ma-x",
  name: "X",
  scripts: { run: "./bin/run.ts" },
  headless: {
    tools: [{ id: "t", handler: { type: "module", path: "./handlers/t.ts" } }],
    promptFragments: [
      { id: "env", handler: { type: "subprocess", command: ["./gather.sh", "--x"] } },
      { id: "js", handler: { type: "subprocess", command: ["./bin/js-cmd.ts"] } },
    ],
    hooks: [{ id: "h", handler: { type: "module", path: "handlers/../handlers/h.ts" } }],
  },
  ui: {
    setup: { type: "module", path: "./ui/setup.ts" },
    liveAreaSlots: [{ id: "s", handler: { type: "module", path: "./ui/slot.ts" } }],
  },
  errorRenderers: [{ id: "e", entry: "./err.ts" }],
  sidebandCodec: { id: "c", entry: "./codec.ts" },
  promptTemplate: { entry: "./tmpl.ts" },
}

function writeFixture(): void {
  pkg("ma-x-plugin", {
    "manifest.json": JSON.stringify(FIXTURE_MANIFEST),
    "PROMPT.md": "x prompt",
    "gather.sh": "#!/bin/sh\necho gathered\n",
    "bin/run.ts": "export async function main(argv: string[]) { return argv.length }\n",
    "bin/js-cmd.ts": "",
    "handlers/t.ts": "export default () => 'tool'\n",
    "handlers/h.ts": "export default () => {}\n",
    "ui/setup.ts": "export default () => {}\n",
    "ui/slot.ts": "export default () => 'slot'\n",
    "err.ts": "",
    "codec.ts": "",
    "tmpl.ts": "",
    "notes.md": "not referenced",
  })
  pkg("ma-llm-y-plugin", {
    "provider.json": JSON.stringify({ id: "y", entry: "./index.ts", export: "y" }),
    "index.ts": "export const y = {}\n",
  })
  pkg("ma-custom-prompt-plugin", {
    "manifest.json": JSON.stringify({ id: "cp", prompt: "./docs/P.md" }),
    "docs/P.md": "custom",
  })
  // Not packages: skipped.
  pkg("node_modules/ma-z", { "manifest.json": "{}" })
  pkg("scripts", { "check.ts": "" })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-gen-embedded-"))
  writeFixture()
})
afterEach(() => {
  clearEmbeddedPlugins()
  rmSync(root, { recursive: true, force: true })
})

describe("manifestRefs", () => {
  test("collects every module entry, scripts, entries, and run files", () => {
    const refs = manifestRefs(FIXTURE_MANIFEST)
    expect([...refs.modules].sort()).toEqual(
      [
        "./bin/js-cmd.ts",
        "./bin/run.ts",
        "./codec.ts",
        "./err.ts",
        "./handlers/t.ts",
        "./tmpl.ts",
        "./ui/setup.ts",
        "./ui/slot.ts",
        "handlers/../handlers/h.ts",
      ].sort(),
    )
    expect(refs.files).toEqual(["./gather.sh"])
  })

  test("an absolute subprocess command is not embedded", () => {
    const refs = manifestRefs({
      headless: { tools: [{ handler: { type: "subprocess", command: ["/usr/bin/env"] } }] },
    })
    expect(refs.files).toEqual([])
    expect(refs.modules).toEqual([])
  })

  test("collects the systemPromptBase and syntheticText entries", () => {
    const refs = manifestRefs({
      systemPromptBase: { id: "base", entry: "./base.ts" },
      syntheticText: [{ id: "a", entry: "./st.ts", export: "make" }, { id: "b" }],
    })
    expect([...refs.modules].sort()).toEqual(["./base.ts", "./st.ts"])
  })

  test("collects the toolText entries", () => {
    const refs = manifestRefs({
      toolText: [{ id: "tools", entry: "./tool-text.ts", tools: ["Bash"] }, { id: "x" }],
    })
    expect([...refs.modules]).toEqual(["./tool-text.ts"])
  })

  test("collects the toolResultTransforms entry", () => {
    const refs = manifestRefs({
      toolResultTransforms: { id: "probe", entry: "./transforms.ts", timeoutMs: 500 },
    })
    expect([...refs.modules]).toEqual(["./transforms.ts"])
    expect(manifestRefs({ toolResultTransforms: { id: "x" } }).modules).toEqual([])
  })
})

describe("prompt assets", () => {
  test("every file under prompts/ is a text, and the table serves it", () => {
    pkg("ma-p-plugin", {
      "manifest.json": JSON.stringify({
        id: "ma-p",
        systemPromptBase: { id: "base", entry: "./base.ts" },
        syntheticText: [{ id: "a", entry: "./st.ts" }],
      }),
      "base.ts": "export default () => ({ identity: () => 'i' })\n",
      "st.ts": "export default () => ({ kinds: [], text: () => 's' })\n",
      "prompts/a.md": "prompt A",
      "prompts/sub/b.tmpl.md": "prompt B",
      "prompts/.hidden": "skip",
    })
    const p = collectPackages(root).find((x) => x.name === "ma-p-plugin")
    expect([...(p?.texts.keys() ?? [])].sort()).toEqual([
      "manifest.json",
      "prompts/a.md",
      "prompts/sub/b.tmpl.md",
    ])
    expect([...(p?.modules.keys() ?? [])].sort()).toEqual(["base.ts", "st.ts"])
  })

  test("a package with no prompts/ dir gets no prompt texts", () => {
    const x = collectPackages(root).find((p) => p.name === "ma-x-plugin")
    expect([...(x?.texts.keys() ?? [])].some((k) => k.startsWith("prompts/"))).toBe(false)
  })
})

describe("renderEmbeddedPluginsModule", () => {
  test("fixture dir -> exact table text (sorted, normalized keys, absolute literals)", () => {
    const text = renderEmbeddedPluginsModule(collectPackages(root), "b1")
    const p = (rel: string): string => JSON.stringify(join(root, rel))
    const expected = [
      "// GENERATED by scripts/gen-embedded-plugins.ts. Do not edit, do not commit.",
      "// biome-ignore-all lint: generated",
      "/* eslint-disable */",
      'import type { EmbeddedPluginTable } from "@minimal-agent/core/host-kit/embedded-plugins"',
      `import t0 from ${p("ma-custom-prompt-plugin/docs/P.md")} with { type: "text" }`,
      `import t1 from ${p("ma-custom-prompt-plugin/manifest.json")} with { type: "text" }`,
      `import t2 from ${p("ma-llm-y-plugin/provider.json")} with { type: "text" }`,
      `import t3 from ${p("ma-x-plugin/PROMPT.md")} with { type: "text" }`,
      `import t4 from ${p("ma-x-plugin/manifest.json")} with { type: "text" }`,
      `import f0 from ${p("ma-x-plugin/gather.sh")} with { type: "file" }`,
      "",
      "export const TABLE: EmbeddedPluginTable = {",
      '  buildId: "b1",',
      "  packages: {",
      '    "ma-custom-prompt-plugin": {',
      "      texts: {",
      '        "docs/P.md": t0,',
      '        "manifest.json": t1,',
      "      },",
      "      modules: {},",
      "      files: {},",
      "    },",
      '    "ma-llm-y-plugin": {',
      "      texts: {",
      '        "provider.json": t2,',
      "      },",
      "      modules: {",
      `        "index.ts": () => import(${p("ma-llm-y-plugin/index.ts")}),`,
      "      },",
      "      files: {},",
      "    },",
      '    "ma-x-plugin": {',
      "      texts: {",
      '        "PROMPT.md": t3,',
      '        "manifest.json": t4,',
      "      },",
      "      modules: {",
      ...[
        "bin/js-cmd.ts",
        "bin/run.ts",
        "codec.ts",
        "err.ts",
        "handlers/h.ts",
        "handlers/t.ts",
        "tmpl.ts",
        "ui/setup.ts",
        "ui/slot.ts",
      ].map((k) => `        "${k}": () => import(${p(`ma-x-plugin/${k}`)}),`),
      "      },",
      "      files: {",
      '        "gather.sh": f0,',
      "      },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n")
    expect(text).toBe(expected)
  })

  test("deterministic: two renders are byte-identical", () => {
    const a = renderEmbeddedPluginsModule(collectPackages(root), "b1")
    const b = renderEmbeddedPluginsModule(collectPackages(root), "b1")
    expect(a).toBe(b)
  })

  test("a bad build id is rejected", () => {
    expect(() => renderEmbeddedPluginsModule([], "../x")).toThrow(EmbedGenError)
  })
})

describe("collectPackages errors", () => {
  test("a manifest module that does not exist fails the build", () => {
    pkg("ma-bad-plugin", {
      "manifest.json": JSON.stringify({
        id: "bad",
        headless: { tools: [{ handler: { type: "module", path: "./missing.ts" } }] },
      }),
    })
    expect(() => collectPackages(root)).toThrow(/missing\.ts does not exist/)
  })

  test("a path outside the package fails the build", () => {
    pkg("ma-esc-plugin", {
      "manifest.json": JSON.stringify({ id: "esc", scripts: { x: "../ma-x-plugin/bin/run.ts" } }),
    })
    expect(() => collectPackages(root)).toThrow(/not inside the package/)
  })

  test("a missing plugins dir fails", () => {
    expect(() => collectPackages(join(root, "nope"))).toThrow(EmbedGenError)
  })
})

describe("the generated module works with core", () => {
  test("registers; texts, modules, files and scripts resolve", async () => {
    // A literal import path (the core-boundary check bans computed ones),
    // in the gitignored tmp/ dir of this repo.
    const out = join(import.meta.dir, "..", "tmp", "gen-embedded-plugins.test.gen.ts")
    const r = writeEmbeddedPluginsModule(root, out, "b2")
    expect(r).toMatchObject({ packages: 3, modules: 10, texts: 5, files: 1, scripts: ["ma-x/run"] })
    expect(readFileSync(out, "utf8")).toContain('buildId: "b2"')
    const { TABLE } = (await import("../tmp/gen-embedded-plugins.test.gen.ts")) as {
      TABLE: Parameters<typeof registerEmbeddedPlugins>[0]
    }
    rmSync(out, { force: true })
    registerEmbeddedPlugins(TABLE, { cacheRoot: join(root, "cache") })
    const pkgs = embeddedPluginPackages()
    expect(pkgs.map((p) => p.name)).toEqual([
      "ma-custom-prompt-plugin",
      "ma-llm-y-plugin",
      "ma-x-plugin",
    ])
    const x = pkgs[2]
    expect(x?.readText("./PROMPT.md")).toBe("x prompt")
    expect(x?.hasFile("./ui/slot.ts")).toBe(true)
    expect(x?.hasFile("./notes.md")).toBe(false)
    const tool = (await x?.importModule("./handlers/t.ts")) as { default: () => string }
    expect(tool.default()).toBe("tool")
    expect(x?.readText("gather.sh")).toContain("echo gathered")
    const run = findEmbeddedScript("ma-x/run")
    expect(run).toBeFunction()
    const mod = (await run?.()) as { main: (argv: string[]) => Promise<number> }
    expect(await mod.main(["a", "b"])).toBe(2)
    expect(findEmbeddedScript("../ma-x-plugin/bin/run.ts")).toBeUndefined()
  })
})
