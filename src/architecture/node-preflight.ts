#!/usr/bin/env bun

import { pathToFileURL } from "node:url"

export const MINIMUM_ARCHITECTURE_NODE_VERSION = "22.18.0"

export interface ArchitectureNodePreflightResult {
  readonly executable: string
  readonly version: string
}

/** Resolve the Node executable selected for architecture checks. */
export function architectureNodeExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment.NODE?.trim() || "node"
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

/** Validate the Node executable used by architecture checks before running them. */
export function preflightArchitectureNode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArchitectureNodePreflightResult {
  const executable = architectureNodeExecutable(environment)
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync([executable, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `architecture checks require Node >=${MINIMUM_ARCHITECTURE_NODE_VERSION}, but ${executable} could not be executed: ${detail}`,
      { cause: error },
    )
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr?.toString().trim() ?? ""
    throw new Error(
      `architecture checks require Node >=${MINIMUM_ARCHITECTURE_NODE_VERSION}, but ${executable} could not be executed${detail ? `: ${detail}` : ""}`,
    )
  }

  const version = result.stdout?.toString().trim() ?? ""
  const actual = parseVersion(version)
  const minimum = parseVersion(MINIMUM_ARCHITECTURE_NODE_VERSION)!
  if (!actual) {
    throw new Error(
      `architecture checks could not parse the Node version from ${executable}: ${version}`,
    )
  }
  if (!isAtLeast(actual, minimum)) {
    throw new Error(
      `architecture checks require Node >=${MINIMUM_ARCHITECTURE_NODE_VERSION}, but ${executable} reports ${version}`,
    )
  }
  return { executable, version }
}

function main(): number {
  try {
    const result = preflightArchitectureNode()
    console.log(`architecture Node preflight: ${result.executable} ${result.version}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main()
}
