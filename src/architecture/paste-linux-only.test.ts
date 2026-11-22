/**
 * Architecture guard (paste plugin v3, J3): the sync clipboard image read in
 * `src/paste/` stays Linux only. macOS and Windows read the image through
 * `Bun.Image.fromClipboard()` (async). No source file in `src/paste/` may
 * shell out to `pngpaste` or `osascript` as a fallback.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PASTE_DIR = join(import.meta.dirname, "..", "paste")
const BANNED = /\b(pngpaste|osascript)\b/

/** Every non-test `.ts` source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p)
  }
  return out
}

/** The banned tokens in `text`, one entry per line that has one. */
function bannedHits(text: string): string[] {
  return text.split("\n").filter((line) => BANNED.test(line))
}

describe("architecture: src/paste keeps the sync clipboard read Linux only (J3)", () => {
  it("scans the moved paste files", () => {
    const names = sourceFiles(PASTE_DIR).map((p) => p.slice(PASTE_DIR.length + 1))
    expect(names).toContain("clipboard.ts")
    expect(names).toContain("paste-intercept.ts")
  })

  it("has no pngpaste and no osascript in src/paste/**", () => {
    const hits = sourceFiles(PASTE_DIR).flatMap((p) =>
      bannedHits(readFileSync(p, "utf8")).map((line) => `${p}: ${line.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it("the scan finds a planted fallback", () => {
    const planted = 'const r = Bun.spawnSync(["pngpaste", "-"])\nrun("osascript", ["-e", s])'
    expect(bannedHits(planted)).toHaveLength(2)
  })
})
