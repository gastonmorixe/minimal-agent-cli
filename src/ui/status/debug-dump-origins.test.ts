/**
 * Origin lookup for the `--debug --verbose` dump: system block subparts,
 * tool owners, and message block references.
 *
 * @module ui/status/debug-dump-origins.test
 */

import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { testSideband } from "../../test-utils/sideband-fixture.ts"
import { blockRef, type DumpOriginSource, systemRefs, toolRef } from "./debug-dump-origins.ts"

const DIR = join(process.cwd(), "plugins", "ma-x-plugin")

/** A source with only the required getter. */
const bare: DumpOriginSource = { loadedPackages: () => [] }

describe("systemRefs", () => {
  it("places each core slot span at its first line", () => {
    const text = "identity\n\n# Instructions\nbe short\n\n# Session context\nstop"
    const src: DumpOriginSource = {
      loadedPackages: () => [],
      describeSystemBlock: () => [
        { slot: "instructions", start: 0, end: 22, overridden: false },
        {
          slot: "sessionContext",
          start: text.indexOf("# Session context"),
          end: text.length,
          overridden: true,
        },
      ],
    }
    expect(systemRefs(text, src, testSideband)).toEqual([
      { atLine: 1, ref: { kind: "core-slot", slot: "instructions", overridden: false } },
      { atLine: 6, ref: { kind: "core-slot", slot: "sessionContext", overridden: true } },
    ])
  })

  it("labels a providerPreamble span with its provider, not 'origin not recorded'", () => {
    const text = "You are Claude Code, Anthropic's official CLI for Claude."
    const src: DumpOriginSource = {
      loadedPackages: () => [{ id: "anthropic", packageDir: DIR }],
      describeSystemBlock: () => [
        {
          slot: "providerPreamble",
          start: 0,
          end: text.length,
          overridden: false,
          providerId: "anthropic",
        },
      ],
    }
    expect(systemRefs(text, src, testSideband)).toEqual([
      {
        atLine: 1,
        ref: {
          kind: "plugin-section",
          tag: "provider preamble",
          pluginId: "anthropic",
          packageDir: DIR,
        },
      },
    ])
  })

  it("labels an overridden providerPreamble span without a package dir", () => {
    const src: DumpOriginSource = {
      loadedPackages: () => [],
      describeSystemBlock: () => [
        { slot: "providerPreamble", start: 0, end: 3, overridden: true, providerId: "p" },
      ],
    }
    expect(systemRefs("abc", src)).toEqual([
      {
        atLine: 1,
        ref: { kind: "plugin-section", tag: "provider preamble overridden", pluginId: "p" },
      },
    ])
  })

  it("matches a `-2` section name and unescapes the tag attribute", () => {
    const text = [
      '<ma::sys::behavior name="style">',
      "a",
      "</ma::sys::behavior>",
      "",
      '<ma::sys::behavior name="style-2">',
      "b",
      "</ma::sys::behavior>",
      '<ma::sys::context name="a &amp; b">',
    ].join("\n")
    const src: DumpOriginSource = {
      loadedPackages: () => [],
      getPromptProvenance: () => ({
        afterInstructions: [],
        sessionContext: [
          { role: "behavior", name: "style", pluginId: "p1", packageDir: DIR },
          { role: "behavior", name: "style-2", pluginId: "p2", packageDir: DIR },
          { role: "context", name: "a & b", pluginId: "p3", packageDir: DIR },
        ],
      }),
    }
    const refs = systemRefs(text, src, testSideband).filter((r) => r.ref.kind === "plugin-section")
    expect(refs.map((r) => [r.atLine, r.ref.kind === "plugin-section" && r.ref.pluginId])).toEqual([
      [1, "p1"],
      [5, "p2"],
      [8, "p3"],
    ])
  })

  it("anchors afterInstructions fragments and marks the host append", () => {
    const after = "frag one\n\nfrag two"
    const text = `# Instructions\nx\n\n${after}\n\nhost text`
    const src: DumpOriginSource = {
      loadedPackages: () => [{ id: "ma-x-plugin", packageDir: DIR }],
      afterInstructionsText: () => after,
      getPromptProvenance: () => ({
        afterInstructions: [
          { pluginId: "ma-x-plugin", fragmentId: "one", start: 0, end: 8 },
          { pluginId: "ma-x-plugin", fragmentId: "two", start: 10, end: 18 },
        ],
        sessionContext: [],
      }),
    }
    expect(systemRefs(text, src, testSideband)).toEqual([
      { atLine: 1, ref: { kind: "unrecorded" } },
      {
        atLine: 4,
        ref: {
          kind: "plugin-fragment",
          pluginId: "ma-x-plugin",
          fragmentId: "one",
          packageDir: DIR,
        },
      },
      {
        atLine: 6,
        ref: {
          kind: "plugin-fragment",
          pluginId: "ma-x-plugin",
          fragmentId: "two",
          packageDir: DIR,
        },
      },
      { atLine: 8, ref: { kind: "host-append" } },
    ])
  })

  it("gives one unrecorded ref for a block with no data", () => {
    expect(systemRefs("plain", bare)).toEqual([{ atLine: 1, ref: { kind: "unrecorded" } }])
  })
})

describe("toolRef", () => {
  const src: DumpOriginSource = {
    loadedPackages: () => [],
    toolOwners: () => new Map([["x__Tool", { pluginId: "ma-x-plugin", packageDir: DIR }]]),
  }

  it("names a plugin tool owner", () => {
    expect(toolRef("x__Tool", src)).toEqual({
      kind: "plugin-tool",
      pluginId: "ma-x-plugin",
      packageDir: DIR,
    })
  })

  it("names a core built-in", () => {
    expect(toolRef("Bash", src)).toEqual({ kind: "core-tool" })
    expect(toolRef("Read", undefined)).toEqual({ kind: "core-tool" })
  })

  it("gives unrecorded for an unknown tool", () => {
    expect(toolRef("Nope", src)).toEqual({ kind: "unrecorded" })
    expect(toolRef("x__Tool", bare)).toEqual({ kind: "unrecorded" })
  })
})

describe("blockRef", () => {
  const names = new Map([["t1", "Bash"]])

  it("names text, attachments, tool_use, tool_result and other blocks", () => {
    expect(blockRef({ block: 0, blockType: "text" }, names, "hi")).toEqual({ kind: "msg-text" })
    expect(
      blockRef({ block: 0, blockType: "text" }, names, '<ma::agent::tasks x="1">', testSideband),
    ).toEqual({
      kind: "msg-attachment",
      name: "tasks",
      tag: "ma::agent::tasks",
    })
    expect(
      blockRef({ block: 0, blockType: "tool_use", toolUseId: "t1", toolName: "Bash" }, names),
    ).toEqual({ kind: "msg-tool-use", toolName: "Bash", toolUseId: "t1" })
    expect(
      blockRef({ block: 0, blockType: "tool_result", toolUseId: "t1", isError: true }, names),
    ).toEqual({ kind: "msg-tool-result", toolName: "Bash", toolUseId: "t1", isError: true })
    expect(blockRef({ block: 0, blockType: "tool_result", toolUseId: "zz" }, names)).toEqual({
      kind: "msg-tool-result",
      toolName: undefined,
      toolUseId: "zz",
      isError: false,
    })
    expect(blockRef({ block: 0, blockType: "image" }, names)).toEqual({
      kind: "msg-other",
      blockType: "image",
    })
  })

  it("an attachment keeps the origin label of its writer", () => {
    // Built from parts, so the test adds no hand-written tag literal.
    const name = "ma::agent::policy"
    const line = `<${name}>x</${name}>`
    expect(
      blockRef(
        { block: 0, blockType: "text", origin: "hooks · user · ~/.minimal-agent/hooks.json" },
        names,
        line,
        testSideband,
      ),
    ).toEqual({
      kind: "msg-attachment",
      name: "policy",
      tag: name,
      origin: "hooks · user · ~/.minimal-agent/hooks.json",
    })
  })
})
