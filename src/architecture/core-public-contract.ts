/**
 * The core contract the CLI may consume.
 *
 * `@minimal-agent/core` publishes these subpaths through its package
 * `exports` map. The CLI installs core from git (see `package.json`) and
 * imports only these subpaths. The plugin contract lives under
 * `./plugin-api` and its `./plugin-api/*` subpaths.
 */
export const CORE_PUBLIC_CONTRACT = {
  exportState: "exported",
  resolvableFromCurrentCorePackage: true,
  packages: ["@minimal-agent/core"],
  coreSubpaths: [
    ".",
    "./sdk/events",
    "./sdk/lifecycle",
    "./sdk/ports",
    "./sdk/agent-core",
    "./host/diagnostics",
    "./host/status-bus",
    "./host/system-block-origins",
    "./host/request-inspector",
    // The sideband API of a loader, and the sideband-only boot (design step 13).
    "./host/sideband",
    // The media gate, registry and token kit for the CLI paste code (src/paste/).
    "./host-kit/media",
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
  // The diagnostic bus. The CLI shows its events in the status area and
  // scrollback (see src/ui/status/). Subpath: ./host/diagnostics.
  diagnostics: [
    "DiagnosticBus",
    "Facility",
    "LogEvent",
    "Severity",
    "createDiagnosticBus",
    "getDiagnosticBus",
  ],
  // The status bus. The CLI live area reads its snapshots. Subpath:
  // ./host/status-bus.
  status: [
    "GLOBAL_STATUS_BUS",
    "StatusActivity",
    "StatusBus",
    "StatusDirection",
    "StatusHandle",
    "StatusSnapshot",
  ],
  // The typed `llm.requestWillSend` channel. The CLI subscribes only with
  // `--debug`, and formats the request dump itself (see src/logging/).
  // Subpath: ./host/request-inspector.
  requestInspector: [
    "REQUEST_WILL_SEND",
    "RequestDiagnostics",
    "RequestInspector",
    "RequestSnapshot",
    "RequestWillSendEvent",
    "createRequestInspector",
    "processRequestInspector",
  ],
} as const

export const LEGACY_CORE_TRANSPORT_CONTRACTS = [
  "TransportFn",
  "SendOptions",
  "StreamedResponse",
] as const
