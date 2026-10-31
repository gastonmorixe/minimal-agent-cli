import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import coreManifest from "@minimal-agent/core/package.json"
import { parseJsonc } from "@minimal-agent/core/plugin-api"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import { serializeEvent } from "@minimal-agent/core/sdk/events"
import { NOOP_LIFECYCLE } from "@minimal-agent/core/sdk/lifecycle"

import packageJson from "../../package.json"
import { CORE_PUBLIC_CONTRACT } from "./core-public-contract.ts"

const REPO_ROOT = join(import.meta.dir, "..", "..")

/**
 * A git URL pinned to a full commit SHA or a release tag, never a branch.
 *
 * The URL must be `git+ssh`. Bun turns a `git+https://github.com/...` URL into
 * a GitHub API tarball download that ignores git credentials, so a private
 * core fails to install in CI. For `git+ssh` Bun runs `git clone` (HTTPS first,
 * then SSH), which honors the credentials CI configures.
 */
const PINNED_CORE_URL =
  /^git\+ssh:\/\/git@github\.com\/gastonmorixe\/minimal-agent-core\.git#(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/u

describe("core dependency", () => {
  test("is the only runtime dependency and is pinned", () => {
    expect(Object.keys(packageJson.dependencies)).toEqual(["@minimal-agent/core"])
    expect(packageJson.dependencies["@minimal-agent/core"]).toMatch(PINNED_CORE_URL)
  })

  test("installs the package named in the contract", () => {
    expect(coreManifest.name).toBe(CORE_PUBLIC_CONTRACT.packages[0])
  })

  test("resolves every contract subpath", () => {
    for (const subpath of CORE_PUBLIC_CONTRACT.coreSubpaths) {
      const specifier = `@minimal-agent/core${subpath.slice(1)}`
      expect(() => Bun.resolveSync(specifier, REPO_ROOT), specifier).not.toThrow()
    }
  })

  test("loads runtime exports through the public subpaths", () => {
    expect(AgentCore).toBeFunction()
    expect(serializeEvent).toBeFunction()
    expect(NOOP_LIFECYCLE).toBeObject()
    expect(parseJsonc('{ "a": 1, // comment\n }')).toEqual({ a: 1 })
  })
})
