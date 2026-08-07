import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { productionTypeScriptFiles } from "./core-boundary.ts"
import { CORE_PUBLIC_CONTRACT } from "./core-public-contract.ts"
import {
  architectureNodeExecutable,
  MINIMUM_ARCHITECTURE_NODE_VERSION,
  preflightArchitectureNode,
} from "./node-preflight.ts"

let directory: string
const checker = join(import.meta.dir, "core-boundary.ts")
const node = preflightArchitectureNode().executable

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "minimal-agent-cli-boundary-"))
  await mkdir(join(directory, "src"))
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ESNext", module: "ESNext", noEmit: true },
      include: ["src"],
    }),
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function inspect(source: string): Promise<{ exitCode: number; output: string }> {
  await writeFile(join(directory, "src", "subject.ts"), source)
  const process = Bun.spawn(
    [node, checker, "--root", join(directory, "src"), "--config", join(directory, "tsconfig.json")],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, output: stdout + stderr }
}

describe("CLI core architecture boundary", () => {
  test("rejects static import/export and package deep imports", async () => {
    const result = await inspect(`
      import { x } from "../../minimal-agent-core/src/x.ts"
      export { y } from "minimal-agent-core/src/y.ts"
      export * from "@minimal-agent/core/src/internal.ts"
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/core-source-import/g)).toHaveLength(3)
  })

  test("rejects literal dynamic import and require of core source", async () => {
    const result = await inspect(`
      void import("../minimal-agent-core/src/runtime.ts")
      require("minimal-agent-core/src/transport.ts")
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/core-source-import/g)).toHaveLength(2)
  })

  test("rejects absolute paths containing a core source segment", async () => {
    const result = await inspect(`
      import { x } from "/opt/checkouts/minimal-agent-core/src/x.ts"
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("core-source-import")
  })

  test("rejects file URLs resolving into core source", async () => {
    const result = await inspect(`
      void import("file:///opt/checkouts/minimal-agent-core/src/runtime.ts")
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("core-source-import")
  })

  test("rejects import-equals declarations of core source", async () => {
    const result = await inspect(`
      import Core = require("minimal-agent-core/src/internal.ts")
      import type OtherCore = require("@minimal-agent/core/src/private.ts")
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/core-source-import/g)).toHaveLength(2)
  })

  test("rejects computed loaders", async () => {
    const result = await inspect(`
      const target = "@minimal-agent/core"
      void import(target)
      require(target + "/runtime")
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/computed-loader/g)).toHaveLength(2)
  })

  test("ignores comments and ordinary strings", async () => {
    const result = await inspect(`
      // import { TransportFn } from "minimal-agent-core/src/transport.ts"
      const example = 'require("../minimal-agent-core/src/runtime.ts")'
      export { example }
    `)
    expect(result).toEqual({ exitCode: 0, output: "" })
  })

  test("rejects legacy contracts, including type-only imports and re-exports", async () => {
    const result = await inspect(`
      import type { TransportFn } from "@minimal-agent/core"
      import { type SendOptions } from "@minimal-agent/core/runtime"
      export type { StreamedResponse } from "minimal-agent-core/public"
      const { TransportFn: alias } = require("@minimal-agent/core")
      import type SendOptions = require("minimal-agent-core")
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("forbidden legacy contract: TransportFn")
    expect(result.output).toContain("forbidden legacy contract: SendOptions")
    expect(result.output).toContain("forbidden legacy contract: StreamedResponse")
    expect(result.output.match(/legacy-transport-contract/g)).toHaveLength(5)
  })

  test("rejects namespace and default access to core packages", async () => {
    const result = await inspect(`
      import * as core from "@minimal-agent/core"
      import coreDefault from "minimal-agent-core/public"
      void core.TransportFn
      void coreDefault
      export * as coreNamespace from "@minimal-agent/core/sdk/events"
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/legacy-transport-contract/g)).toHaveLength(3)
    expect(result.output).toContain("default and namespace access to core packages is forbidden")
  })

  test("rejects destructured legacy contracts from awaited dynamic imports", async () => {
    const result = await inspect(`
      const { TransportFn } = await import("@minimal-agent/core")
      void TransportFn
    `)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("forbidden legacy contract: TransportFn")
    expect(result.output.match(/legacy-transport-contract/g)).toHaveLength(1)
  })

  test("permits planned public core subpaths and plugin API", async () => {
    const result = await inspect(`
      import type { AgentEvent, EventSink } from "@minimal-agent/core/sdk/events"
      import type { LifecyclePort } from "@minimal-agent/core/sdk/lifecycle"
      import type { SessionPersistence } from "@minimal-agent/core/sdk/ports"
      import type { Plugin } from "@minimal-agent/plugin-api"
    `)
    expect(result).toEqual({ exitCode: 0, output: "" })
  })

  test("enumerates production TypeScript only", async () => {
    await writeFile(join(directory, "src", "ignored.test.ts"), "export {}")
    expect(
      (await productionTypeScriptFiles(join(directory, "src"))).map((file) =>
        file.split("/").at(-1),
      ),
    ).toEqual(["subject.ts"])
  })

  test("skips dependency, generated, build, vendor, fixture, and hidden trees", async () => {
    const skippedDirectories = [
      "node_modules",
      ".cache",
      "dist",
      "build",
      "coverage",
      "generated",
      "vendor",
      "fixture",
      "fixtures",
      "__fixtures__",
    ]
    await Promise.all(
      skippedDirectories.map(async (name) => {
        const skipped = join(directory, "src", name)
        await mkdir(skipped, { recursive: true })
        await writeFile(join(skipped, "ignored.ts"), "export {}")
      }),
    )
    const production = join(directory, "src", "feature")
    await mkdir(production, { recursive: true })
    await writeFile(join(production, "included.ts"), "export {}")

    expect(
      (await productionTypeScriptFiles(join(directory, "src"))).map((file) =>
        file.slice(join(directory, "src").length + 1),
      ),
    ).toEqual(["feature/included.ts", "subject.ts"])
  })

  test("honors the NODE override", () => {
    expect(architectureNodeExecutable({ NODE: "/custom/node" })).toBe("/custom/node")
  })

  test("rejects an unavailable Node executable", () => {
    expect(() => preflightArchitectureNode({ NODE: join(directory, "missing-node") })).toThrow(
      `architecture checks require Node >=${MINIMUM_ARCHITECTURE_NODE_VERSION}`,
    )
  })

  test("rejects a Node version below the type-stripping baseline", async () => {
    const fakeNode = join(directory, "old-node")
    await writeFile(fakeNode, "#!/bin/sh\necho v22.17.0\n", { mode: 0o755 })
    expect(() => preflightArchitectureNode({ NODE: fakeNode })).toThrow(
      `architecture checks require Node >=${MINIMUM_ARCHITECTURE_NODE_VERSION}`,
    )
  })

  test("current production sources satisfy the boundary", async () => {
    const process = Bun.spawn([node, checker], {
      cwd: join(import.meta.dir, "..", ".."),
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  })

  test("publishes the planned machine-readable contract without invented names", () => {
    expect(CORE_PUBLIC_CONTRACT.status).toBe("planned-not-exported")
    expect(CORE_PUBLIC_CONTRACT.resolvableFromCurrentCorePackage).toBeFalse()
    expect(CORE_PUBLIC_CONTRACT.packages).toEqual([
      "@minimal-agent/core",
      "@minimal-agent/plugin-api",
    ])
    expect(CORE_PUBLIC_CONTRACT.events).toEqual(["AgentEvent", "EventSink"])
    expect(CORE_PUBLIC_CONTRACT.ports).toContain("SessionPersistence")
    expect(CORE_PUBLIC_CONTRACT.engine).toEqual(["AgentCore"])
    expect(CORE_PUBLIC_CONTRACT.blockedUntilProgram2).toContain("host-safe construction contract")
    expect(JSON.stringify(CORE_PUBLIC_CONTRACT)).not.toMatch(
      /createAgentRuntime|AgentRequest|SessionPort|PluginPort/,
    )
  })
})
