/**
 * B1 wiring: the interactive session opens a runtime `Session`, which has
 * no loader, so `textProvidersOf` carries the loader's text providers.
 */

import { describe, expect, it } from "bun:test"

import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import type { SyntheticTextProvider } from "@minimal-agent/core/plugin-api/types/synthetic-text"

import { textProvidersOf } from "./interactive-session.ts"

const stub = (text: string): SyntheticTextProvider => ({
  kinds: ["continue.max_tokens"],
  text: () => text,
})

function loaderWith(providers: SyntheticTextProvider[]): PluginLoader {
  return {
    syntheticTextProviders: () => providers,
    toolTextProviders: () => [],
  } as unknown as PluginLoader
}

describe("textProvidersOf (B1)", () => {
  it("defaults to the loader's providers", () => {
    const out = textProvidersOf({ loader: loaderWith([stub("X-cli")]) })
    expect(out.syntheticTextProviders?.[0]?.text("continue.max_tokens", {} as never)).toBe("X-cli")
    expect(out.toolTextProviders).toEqual([])
  })

  it("lets an explicit value win", () => {
    const explicit = [stub("X-explicit")]
    const out = textProvidersOf({
      loader: loaderWith([stub("X-cli")]),
      syntheticTextProviders: explicit,
    })
    expect(out.syntheticTextProviders).toBe(explicit)
  })

  it("is empty with no loader", () => {
    expect(textProvidersOf({ loader: null })).toEqual({})
  })

  it("tolerates a stub loader without the methods", () => {
    expect(textProvidersOf({ loader: {} as unknown as PluginLoader })).toEqual({})
  })
})
