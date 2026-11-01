import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { importPluginModule } from "../plugins-ui/plugin-module.ts"

import { boundaryTypeScriptFiles, PLUGIN_CODE_LOADER_FILES } from "./core-boundary.ts"
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

async function inspect(
  source: string,
  extraRoots: readonly string[] = [],
): Promise<{ exitCode: number; output: string }> {
  await writeFile(join(directory, "src", "subject.ts"), source)
  const roots = [join(directory, "src"), ...extraRoots].flatMap((root) => ["--root", root])
  const process = Bun.spawn(
    [node, checker, ...roots, "--config", join(directory, "tsconfig.json")],
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

  test("permits public core subpaths and plugin API", async () => {
    const result = await inspect(`
      import type { AgentEvent, EventSink } from "@minimal-agent/core/sdk/events"
      import type { LifecyclePort } from "@minimal-agent/core/sdk/lifecycle"
      import type { SessionPersistence } from "@minimal-agent/core/sdk/ports"
      import type { Plugin } from "@minimal-agent/core/plugin-api"
    `)
    expect(result).toEqual({ exitCode: 0, output: "" })
  })

  test("rejects a deep core import inside a test file (S3 negative control)", async () => {
    const testFile = join(directory, "src", "deep.test.ts")
    await writeFile(testFile, 'import { x } from "@minimal-agent/core/src/x.ts"\nexport { x }\n')
    try {
      const result = await inspect("export {}")
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("deep.test.ts:1:1 core-source-import")
    } finally {
      await rm(testFile)
    }
  })

  test("rejects a deep core import inside a fixture file", async () => {
    const fixtures = join(directory, "src", "fixtures")
    await mkdir(fixtures, { recursive: true })
    await writeFile(join(fixtures, "child.ts"), 'import "minimal-agent-core/src/runtime.ts"\n')
    try {
      const result = await inspect("export {}")
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("child.ts:1:1 core-source-import")
    } finally {
      await rm(fixtures, { recursive: true, force: true })
    }
  })

  test("rejects a deep core import in a root outside the TypeScript project", async () => {
    const scripts = join(directory, "scripts")
    await mkdir(scripts, { recursive: true })
    await writeFile(join(scripts, "tool.ts"), 'import "@minimal-agent/core/src/x.ts"\n')
    try {
      const result = await inspect("export {}", [scripts])
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("tool.ts:1:1 core-source-import")
    } finally {
      await rm(scripts, { recursive: true, force: true })
    }
  })

  test("enumerates production, test, and fixture TypeScript", async () => {
    const fixtures = join(directory, "src", "fixtures")
    await mkdir(fixtures, { recursive: true })
    await writeFile(join(fixtures, "child.ts"), "export {}")
    await writeFile(join(directory, "src", "included.test.ts"), "export {}")
    try {
      expect(
        (await boundaryTypeScriptFiles(join(directory, "src"))).map((file) =>
          file.slice(join(directory, "src").length + 1),
        ),
      ).toEqual(["fixtures/child.ts", "included.test.ts", "subject.ts"])
    } finally {
      await rm(fixtures, { recursive: true, force: true })
      await rm(join(directory, "src", "included.test.ts"))
    }
  })

  test("skips dependency, generated, build, vendor, and hidden trees", async () => {
    const skippedDirectories = [
      "node_modules",
      ".cache",
      "dist",
      "build",
      "coverage",
      "generated",
      "vendor",
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
      (await boundaryTypeScriptFiles(join(directory, "src"))).map((file) =>
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

  test("current sources, tests, and scripts satisfy the boundary", async () => {
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

  test("publishes the exported machine-readable contract without invented names", () => {
    expect(CORE_PUBLIC_CONTRACT.exportState).toBe("exported")
    expect(CORE_PUBLIC_CONTRACT.resolvableFromCurrentCorePackage).toBeTrue()
    expect(CORE_PUBLIC_CONTRACT.packages).toEqual(["@minimal-agent/core"])
    expect(CORE_PUBLIC_CONTRACT.coreSubpaths).toContain("./plugin-api")
    expect(CORE_PUBLIC_CONTRACT.events).toEqual(["AgentEvent", "EventSink"])
    expect(CORE_PUBLIC_CONTRACT.ports).toContain("SessionPersistence")
    expect(CORE_PUBLIC_CONTRACT.engine).toEqual(["AgentCore"])
    expect(CORE_PUBLIC_CONTRACT.coreSubpaths).toContain(".")
    expect(CORE_PUBLIC_CONTRACT.construction).toEqual([
      "createRuntime",
      "Session",
      "SessionOptions",
    ])
    expect(CORE_PUBLIC_CONTRACT.completion).toEqual(["TurnResult"])
    expect(CORE_PUBLIC_CONTRACT.coreSubpaths).toContain("./host/diagnostics")
    expect(CORE_PUBLIC_CONTRACT.coreSubpaths).toContain("./host/status-bus")
    expect(CORE_PUBLIC_CONTRACT.diagnostics).toContain("DiagnosticBus")
    expect(CORE_PUBLIC_CONTRACT.status).toContain("StatusBus")
    expect(CORE_PUBLIC_CONTRACT).not.toHaveProperty("blockedUntilProgram2")
    expect(JSON.stringify(CORE_PUBLIC_CONTRACT)).not.toMatch(
      /createAgentRuntime|AgentRequest|SessionPort|PluginPort/,
    )
  })
})

describe("plugin code loader exemption (S35)", () => {
  test("exactly one CLI file may import by a computed path", () => {
    expect(PLUGIN_CODE_LOADER_FILES).toEqual(["plugins-ui/plugin-module.ts"])
  })

  test("that loader refuses a relative path and core code", async () => {
    // More cases (links, other checkout names): plugins-ui/plugin-module.test.ts.
    const cliRoot = join(import.meta.dir, "..", "..")
    const coreEntry = join(
      cliRoot,
      "node_modules",
      "@minimal-agent",
      "core",
      "src",
      "sdk",
      "runtime.ts",
    )
    await expect(importPluginModule("./x.ts", cliRoot)).rejects.toThrow(/must be absolute/)
    await expect(importPluginModule(coreEntry, cliRoot)).rejects.toThrow(/names core code/)
  })
})
