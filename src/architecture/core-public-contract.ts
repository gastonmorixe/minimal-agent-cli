/**
 * Target identifiers for Program 3B design and import ratchets.
 *
 * These are not resolvable package exports yet. The current core package is
 * still named `minimal-agent` and has no `exports` map. Production CLI code
 * must not import these subpaths until core publishes the matching contract.
 */
export const CORE_PUBLIC_CONTRACT = {
  status: "planned-not-exported",
  resolvableFromCurrentCorePackage: false,
  packages: ["@minimal-agent/core", "@minimal-agent/plugin-api"],
  coreSubpaths: ["./sdk/events", "./sdk/lifecycle", "./sdk/ports", "./sdk/agent-core"],
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
  blockedUntilProgram2: ["host-safe construction contract", "stable completion DTO"],
} as const

export const LEGACY_CORE_TRANSPORT_CONTRACTS = [
  "TransportFn",
  "SendOptions",
  "StreamedResponse",
] as const
