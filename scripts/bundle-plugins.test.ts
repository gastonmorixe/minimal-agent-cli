import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { buildPluginCatalog } from "@minimal-agent/core/host/plugin-catalog"

import { bundlePlugins, findUnsafePatterns, readBundleList } from "./bundle-plugins.ts"

function fixture(list: unknown[], files: Record<string, string> = { "manifest.json": '{"id":"x","name":"X","embeddable":true}' }) {
  const tmp = mkdtempSync(join(tmpdir(), "ma-bundle-"))
  const repo = join(tmp, "repo")
  mkdirSync(join(repo, "ma-x-plugin"), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(repo, "ma-x-plugin", name), text)
  }
  const listFile = join(tmp, "plugins.bundle.json")
  writeFileSync(listFile, JSON.stringify({ plugins: list }))
  return { tmp, repo, listFile, destDir: join(tmp, "plugins") }
}

describe("bundlePlugins", () => {
  test("empty list creates nothing", () => {
    const f = fixture([])
    try {
      const done = bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })
      expect(done).toEqual([])
      expect(existsSync(f.destDir)).toBe(false)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("copies a listed plugin and the catalog sees it as embedded", () => {
    const f = fixture(["ma-x-plugin"])
    try {
      const done = bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })
      expect(done).toEqual(["ma-x-plugin"])
      expect(readFileSync(join(f.destDir, "ma-x-plugin", "manifest.json"), "utf8")).toContain('"x"')
      const entries = buildPluginCatalog(
        { embedded: [f.destDir] },
        {
          config: { forceDisabled: new Set(), forceEnabled: new Set() },
          env: {},
        },
      )
      const entry = entries.find((e) => e.id === "x")
      expect(entry).toBeDefined()
      expect(entry?.root).toBe("embedded")
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("rejects bad ids", () => {
    for (const bad of ["../evil", "a/b", "..", "", 5]) {
      const f = fixture([bad])
      try {
        expect(() =>
          bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir }),
        ).toThrow(/bad plugin id/)
        expect(existsSync(f.destDir)).toBe(false)
      } finally {
        rmSync(f.tmp, { recursive: true, force: true })
      }
    }
  })

  test("rejects a source without manifest.json or provider.json", () => {
    const f = fixture(["ma-x-plugin"], { "readme.md": "x" })
    try {
      expect(() =>
        bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir }),
      ).toThrow(/no manifest\.json or provider\.json/)
      expect(existsSync(f.destDir)).toBe(false)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("accepts a provider.json package", () => {
    const f = fixture(["ma-x-plugin"], { "provider.json": '{"embeddable":true}' })
    try {
      bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })
      expect(existsSync(join(f.destDir, "ma-x-plugin", "provider.json"))).toBe(true)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("refuses a plugin that is not embeddable and names the id", () => {
    const f = fixture(["ma-x-plugin"], { "manifest.json": '{"id":"x","name":"X"}' })
    try {
      expect(() =>
        bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir }),
      ).toThrow(/"ma-x-plugin" is not embeddable/)
      expect(existsSync(f.destDir)).toBe(false)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("refuses a subprocess handler even when embeddable", () => {
    const manifest = JSON.stringify({
      id: "x",
      embeddable: true,
      headless: { promptFragments: [{ handler: { type: "subprocess", command: ["./g.sh"] } }] },
    })
    const f = fixture(["ma-x-plugin"], { "manifest.json": manifest })
    try {
      expect(() =>
        bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir }),
      ).toThrow(/ma-x-plugin" declares a subprocess handler/)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("transpiles .ts, rewrites specifiers and manifest paths in the copy only", () => {
    const manifest = JSON.stringify({
      id: "x",
      embeddable: true,
      headless: { tools: [{ handler: { type: "module", path: "./h/run.ts" } }] },
    })
    const f = fixture(["ma-x-plugin"], {
      "manifest.json": manifest,
      "notes.md": "keep",
    })
    const src = join(f.repo, "ma-x-plugin")
    mkdirSync(join(src, "h"), { recursive: true })
    mkdirSync(join(src, "scripts"), { recursive: true })
    mkdirSync(join(src, "node_modules"), { recursive: true })
    writeFileSync(join(src, "scripts", "dev.ts"), "export const d = 1")
    writeFileSync(join(src, "node_modules", "m.ts"), "export const m = 1")
    writeFileSync(join(src, "h", "run.test.ts"), "export const t = 1")
    writeFileSync(join(src, "h", "types.d.ts"), "export type T = 1")
    writeFileSync(join(src, "h", "dep.ts"), "export const DEP: number = 1\nexport type Foo = string\n")
    writeFileSync(
      join(src, "h", "run.ts"),
      'import { DEP, type Foo } from "./dep.ts"\nexport { DEP as D2 } from "./dep.ts"\nexport default async function run(x: Foo) { const m = await import("./dep.ts"); return [DEP, x, m] }\n',
    )
    const before = readFileSync(join(src, "manifest.json"), "utf8")
    try {
      bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })
      const out = join(f.destDir, "ma-x-plugin")
      expect(existsSync(join(out, "h", "run.ts"))).toBe(false)
      expect(existsSync(join(out, "h", "dep.js"))).toBe(true)
      expect(existsSync(join(out, "h", "run.test.ts"))).toBe(false)
      expect(existsSync(join(out, "h", "types.d.ts"))).toBe(false)
      expect(existsSync(join(out, "scripts"))).toBe(false)
      expect(existsSync(join(out, "node_modules"))).toBe(false)
      expect(readFileSync(join(out, "notes.md"), "utf8")).toBe("keep")
      const js = readFileSync(join(out, "h", "run.js"), "utf8")
      expect(js).not.toContain(".ts")
      expect(js).toContain('"./dep.js"')
      expect(js).not.toContain("Foo")
      const copied = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))
      expect(copied.headless.tools[0].handler.path).toBe("./h/run.js")
      expect(readFileSync(join(src, "manifest.json"), "utf8")).toBe(before)
      expect(existsSync(join(src, "h", "run.ts"))).toBe(true)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("a bad pattern fails with file:line and passes with embeddableChecked", () => {
    const code = 'export const a = 1\nexport const u = new URL("./x.md", import.meta.url)\n'
    const f = fixture(["ma-x-plugin"])
    writeFileSync(join(f.repo, "ma-x-plugin", "bad.ts"), code)
    try {
      expect(() =>
        bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir }),
      ).toThrow(/bad\.ts:2 matches check new-url-import-meta/)
      expect(existsSync(f.destDir)).toBe(false)
      writeFileSync(
        join(f.repo, "ma-x-plugin", "manifest.json"),
        '{"id":"x","embeddable":true,"embeddableChecked":true}',
      )
      expect(bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })).toEqual([
        "ma-x-plugin",
      ])
      expect(existsSync(join(f.destDir, "ma-x-plugin", "bad.js"))).toBe(true)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("the real plugins.bundle.json parses and is empty today", () => {
    const real = resolve(import.meta.dir, "..", "plugins.bundle.json")
    expect(readBundleList(real)).toEqual([])
  })
})

describe("findUnsafePatterns", () => {
  test("flags createRequire(import.meta.url)", () => {
    const hits = findUnsafePatterns('import { createRequire } from "node:module"\nconst r = createRequire(import.meta.url)\n')
    expect(hits).toEqual([{ line: 2, check: "create-require-import-meta" }])
  })

  test("flags a non-literal .ts string but not an import specifier", () => {
    const hits = findUnsafePatterns(
      'import { a } from "./a.ts"\nexport * from "./b.ts"\nconst m = await import("./c.ts")\n// "./d.ts"\nconst p = join(HERE, "cdp-server.ts")\n',
    )
    expect(hits).toEqual([{ line: 5, check: "non-literal-ts-string" }])
  })

  test("clean source has no hits", () => {
    expect(findUnsafePatterns("export const a = 1\n")).toEqual([])
  })
})
