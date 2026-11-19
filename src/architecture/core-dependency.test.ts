import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { createRuntime, Session, type SessionOptions } from "@minimal-agent/core"
import {
  createDiagnosticBus,
  type DiagnosticBus,
  Facility,
  getDiagnosticBus,
  type LogEvent,
  Severity,
} from "@minimal-agent/core/host/diagnostics"
import {
  createRequestInspector,
  processRequestInspector,
  REQUEST_WILL_SEND,
  type RequestDiagnostics,
  type RequestInspector,
  type RequestSnapshot,
  type RequestWillSendEvent,
} from "@minimal-agent/core/host/request-inspector"
import {
  GLOBAL_STATUS_BUS,
  type StatusActivity,
  StatusBus,
  type StatusDirection,
  type StatusHandle,
  type StatusSnapshot,
} from "@minimal-agent/core/host/status-bus"
import { name as coreName } from "@minimal-agent/core/package.json"
import { parseJsonc } from "@minimal-agent/core/plugin-api"
import { AgentCore, type TurnResult } from "@minimal-agent/core/sdk/agent-core"
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
    expect(coreName).toBe(CORE_PUBLIC_CONTRACT.packages[0])
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

  test("exports the construction contract and the completion DTO", () => {
    expect(createRuntime).toBeFunction()
    expect(Session).toBeFunction()
    // Type-level checks: these fail typecheck if core drops the names.
    const options: keyof SessionOptions = "model"
    const outcome: TurnResult["outcome"] | undefined = undefined
    expect(options).toBe("model")
    expect(outcome).toBeUndefined()
  })

  test("exports the diagnostics and status groups (S11)", () => {
    expect(createDiagnosticBus).toBeFunction()
    expect(getDiagnosticBus).toBeFunction()
    expect(StatusBus).toBeFunction()
    expect(GLOBAL_STATUS_BUS).toBeInstanceOf(StatusBus)
    // Type-level checks: these fail typecheck if core drops the names.
    // `Facility` and `Severity` are const enums, so only a type query works.
    type Types = [
      DiagnosticBus,
      typeof Facility,
      LogEvent,
      typeof Severity,
      StatusActivity,
      StatusDirection,
      StatusHandle,
      StatusSnapshot,
    ]
    const count: Types["length"] = 8
    expect(count).toBe(8)
    const names: readonly string[] = [
      ...CORE_PUBLIC_CONTRACT.diagnostics,
      ...CORE_PUBLIC_CONTRACT.status,
    ]
    expect(names).toHaveLength(12)
  })

  test("exports the request inspector group", () => {
    expect(REQUEST_WILL_SEND).toBe("llm.requestWillSend")
    expect(createRequestInspector).toBeFunction()
    expect(processRequestInspector).toBeFunction()
    expect(processRequestInspector()).toBe(processRequestInspector())
    // Type-level checks: these fail typecheck if core drops the names.
    type Types = [RequestDiagnostics, RequestInspector, RequestSnapshot, RequestWillSendEvent]
    const count: Types["length"] = 4
    expect(count).toBe(4)
    expect(CORE_PUBLIC_CONTRACT.requestInspector).toHaveLength(7)
  })
})
