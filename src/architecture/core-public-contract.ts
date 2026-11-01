/**
 * The core contract the CLI may consume.
 *
 * `@minimal-agent/core` publishes these subpaths through its package
 * `exports` map. The CLI installs core from git (see `package.json`) and
 * imports only these subpaths. The plugin contract lives under
 * `./plugin-api` and its `./plugin-api/*` subpaths.
 */
export const CORE_PUBLIC_CONTRACT = {
  status: "exported",
  resolvableFromCurrentCorePackage: true,
  packages: ["@minimal-agent/core"],
  coreSubpaths: [
    ".",
    "./sdk/events",
    "./sdk/lifecycle",
    "./sdk/ports",
    "./sdk/agent-core",
    "./plugin-api",
  ],
  events: ["AgentEvent", "EventSink"],
  lifecycle: ["LifecyclePort", "PolicyDecision", "NOOP_LIFECYCLE"],
  ports: [
    "ToolDefinition",
    "ToolExecResult",
    "ToolExecutor",
    "ToolRegistry",
    "ToolAdvertisementFilter",
    "SessionPersistence",
    "ModeProvider",
    "MediaResolver",
  ],
  engine: ["AgentCore"],
  // The host-safe construction contract. Every CLI route opens its session
  // through these names (see src/routes.test.ts).
  construction: ["createRuntime", "Session", "SessionOptions"],
  // The stable completion DTO. `Session.run().result` resolves to it.
  completion: ["TurnResult"],
} as const

export const LEGACY_CORE_TRANSPORT_CONTRACTS = [
  "TransportFn",
  "SendOptions",
  "StreamedResponse",
] as const
