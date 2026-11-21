import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { clearModelRegistry, registerModel } from "@minimal-agent/core/host/model-registry"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { makeCharRatioEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"
import { snapOf } from "../ui/status/debug-dump.fixtures.ts"
import { dumpView, safeJson } from "./request-dump-model.ts"
import { dumpEstimator, sizeLabel, sizeOf, sumSizes } from "./request-dump-size.ts"

/** An explicit test estimator: 3.5 chars for each token. */
const EST = makeCharRatioEstimator(3.5)
const MODEL = "dump-size-model"
const PROVIDER = "dump-size-provider"

function registerEstimated(): void {
  registerModel({
    id: MODEL,
    providerId: PROVIDER,
    surfaceId: "messages",
    displayName: "Dump Size",
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 1,
      outputUSD: 2,
      cacheWriteUSD: 1,
      cacheReadUSD: 0.5,
      webSearchPerCallUSD: 0,
    },
    estimateTokens: EST,
  })
}

/** A snapshot with each section, headers and body. */
function snapshot(model: string, providerId?: string) {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  const content = [{ type: "text", text: "hi" }]
  const snap = snapOf({
    model,
    tools: [{ name: "T", description: "desc", input_schema: schema }],
    system: [{ type: "text", text: "sys" }],
    messages: [{ role: "user", content }],
  })
  return {
    schema,
    content,
    req: {
      ...snap,
      ...(providerId === undefined ? {} : { providerId }),
      headers: { "x-a": "b" },
      body: { k: 1 },
    },
  }
}

describe("request dump sizes", () => {
  beforeEach(() => {
    clearModelRegistry()
    registerEstimated()
  })
  afterEach(() => {
    clearModelRegistry()
  })

  it("counts UTF-8 bytes, and tokens only with an estimator", () => {
    expect(sizeOf(EST, "héllo")).toEqual({ bytes: 6, tokens: EST("héllo") })
    expect(sizeOf(undefined, "héllo")).toEqual({ bytes: 6 })
  })
  it("looks up the estimator of the (provider, model) pair, with no fallback", () => {
    expect(dumpEstimator(MODEL, PROVIDER)).toBe(EST)
    expect(dumpEstimator(MODEL, undefined)).toBe(EST)
    expect(dumpEstimator("unknown-model", PROVIDER)).toBeUndefined()
    expect(dumpEstimator(undefined, undefined)).toBeUndefined()
  })
  it("sums and labels", () => {
    expect(
      sumSizes([
        { bytes: 1, tokens: 2 },
        { bytes: 3, tokens: 4 },
      ]),
    ).toEqual({ bytes: 4, tokens: 6 })
    expect(sumSizes([{ bytes: 1 }, { bytes: 3 }])).toEqual({ bytes: 4 })
    expect(sizeLabel({ bytes: 2048, tokens: 12300 })).toBe("2.0 kB · ~12.3k tok")
    expect(sizeLabel({ bytes: 2048 })).toBe("2.0 kB")
  })
  it("sizes each part from its wire text with the estimator, and totals once per view", () => {
    const { schema, content, req } = snapshot(MODEL, PROVIDER)
    const v = dumpView(req, { lines: true })
    const tools = v.sections.find((s) => s.name === "tools")
    expect(tools?.parts[0]?.size).toEqual(sizeOf(EST, `Tdesc${safeJson(schema, 0)}`))
    expect(v.sections.find((s) => s.name === "system")?.parts[0]?.size).toEqual(sizeOf(EST, "sys"))
    const msg = v.sections.find((s) => s.name === "messages")?.parts[0]
    expect(msg?.size).toEqual(sizeOf(EST, safeJson(content, 0)))
    expect(msg?.blocks[0]?.size).toEqual(sizeOf(EST, safeJson(content[0], 0)))
    expect(v.kv[0]?.rows[0]?.size).toEqual(sizeOf(EST, "x-ab"))
    expect(v.kv[1]?.rows[0]?.size).toEqual(sizeOf(EST, "k1"))
    const all = [...v.kv.map((k) => k.size), ...v.sections.map((s) => s.size)]
    expect(v.size).toEqual(sumSizes(all.map((s) => s ?? { bytes: 0, tokens: 0 })))
    expect(v.size?.tokens).toBeGreaterThan(0)
  })
  it("gives bytes only for each part, section and the total with no estimator", () => {
    const { schema, content, req } = snapshot("unknown-model")
    const v = dumpView(req, { lines: true })
    expect(v.sections.find((s) => s.name === "tools")?.parts[0]?.size).toEqual({
      bytes: sizeOf(undefined, `Tdesc${safeJson(schema, 0)}`).bytes,
    })
    const msg = v.sections.find((s) => s.name === "messages")?.parts[0]
    expect(msg?.size).toEqual(sizeOf(undefined, safeJson(content, 0)))
    for (const s of v.sections) expect(s.size?.tokens).toBeUndefined()
    for (const k of v.kv) expect(k.size?.tokens).toBeUndefined()
    expect(v.size?.tokens).toBeUndefined()
    expect(v.size?.bytes).toBeGreaterThan(0)
  })
  it("gives an empty messages section a zero token count only with an estimator", () => {
    const with_ = dumpView(snapOf({ model: MODEL }), { lines: false })
    expect(with_.sections.find((s) => s.name === "messages")?.size).toEqual({ bytes: 0, tokens: 0 })
    const without = dumpView(snapOf({ model: "unknown-model" }), { lines: false })
    expect(without.sections.find((s) => s.name === "messages")?.size).toEqual({ bytes: 0 })
  })
})
