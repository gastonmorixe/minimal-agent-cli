import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { buildPluginCatalog } from "@minimal-agent/core/host/plugin-catalog"

import { bundlePlugins, readBundleList } from "./bundle-plugins.ts"

function fixture(list: unknown[], files: Record<string, string> = { "manifest.json": '{"id":"x","name":"X"}' }) {
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
    const f = fixture(["ma-x-plugin"], { "provider.json": "{}" })
    try {
      bundlePlugins({ listFile: f.listFile, pluginsRepo: f.repo, destDir: f.destDir })
      expect(existsSync(join(f.destDir, "ma-x-plugin", "provider.json"))).toBe(true)
    } finally {
      rmSync(f.tmp, { recursive: true, force: true })
    }
  })

  test("the real plugins.bundle.json parses and is empty today", () => {
    const real = resolve(import.meta.dir, "..", "plugins.bundle.json")
    expect(readBundleList(real)).toEqual([])
  })
})
