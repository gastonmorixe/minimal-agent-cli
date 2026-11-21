/**
 * Subagent inheritance labels for every global CLI flag (SPEC T7, goal 2.3).
 *
 * `inherit`: the worker gets the lead's resolved value through the
 * `--startup-profile` file. `worker-clamp`: the spawn plan sets a clamped value
 * for the worker. `no-inherit`: the worker does not get it, and `reason` says
 * why. `subagent-inheritance.test.ts` fails when a global flag has no label.
 * Pure data. No import from a core host module.
 */

/** How a lead flag reaches a subagent worker. */
export type SubagentInheritLabel = "inherit" | "worker-clamp" | "no-inherit"

/** One label entry. `reason` is required for `no-inherit`. */
export interface SubagentInheritEntry {
  readonly label: SubagentInheritLabel
  readonly reason?: string
}

const INHERIT: SubagentInheritEntry = { label: "inherit" }
const CLAMP: SubagentInheritEntry = { label: "worker-clamp" }
const no = (reason: string): SubagentInheritEntry => ({ label: "no-inherit", reason })

const UNREVIEWED = no("unreviewed")
const DISPLAY = no("display only, the worker has no terminal")
const ONE_SHOT = no("one-shot lead I/O, the spawn plan sets worker I/O")
const SESSION = no("lead session identity, the worker has its own session")
const INFO = no("info or account command, not a run setting")

const SYSTEM_PROMPT_PARTS = [
  "system-prompt",
  "system-identity",
  "system-instructions",
  "system-session-context",
  "provider-system-preamble",
] as const

const systemPromptEntries = Object.fromEntries(
  SYSTEM_PROMPT_PARTS.flatMap((part) => [
    [part, INHERIT],
    [`${part}-file`, INHERIT],
    [`no-${part}`, INHERIT],
  ]),
) as Record<string, SubagentInheritEntry>

/** Label of each global flag, keyed by the flag `name` (long form, no dashes). */
export const SUBAGENT_INHERITANCE: Readonly<Record<string, SubagentInheritEntry>> = {
  // Model and provider: the spawn plan picks the worker value.
  model: CLAMP,
  provider: CLAMP,
  effort: CLAMP,
  "credential-name": CLAMP,
  fast: UNREVIEWED,
  "thinking-display": DISPLAY,
  "cache-ttl": UNREVIEWED,
  // Prompt-cache flags: the worker gets the lead value through the profile.
  "cache-anchor": INHERIT,
  "thinking-history": INHERIT,
  "service-tier": UNREVIEWED,
  temperature: UNREVIEWED,
  // Generic endpoint settings.
  endpoint: UNREVIEWED,
  format: UNREVIEWED,
  "auth-type": UNREVIEWED,
  "api-key": no("secret, never written to the startup profile"),
  "auth-header": no("secret, never written to the startup profile"),
  "provider-model": UNREVIEWED,
  "effort-levels": UNREVIEWED,
  // Output and I/O.
  prompt: ONE_SHOT,
  "output-format": ONE_SHOT,
  json: ONE_SHOT,
  diagnostics: ONE_SHOT,
  "output-schema": ONE_SHOT,
  "input-format": ONE_SHOT,
  strict: no("tied to the lead --output-schema"),
  "schema-retries": no("tied to the lead --output-schema"),
  formatter: DISPLAY,
  "formatter-args": DISPLAY,
  spinner: DISPLAY,
  header: DISPLAY,
  "header-format": DISPLAY,
  "no-color": DISPLAY,
  "show-hidden-chars": DISPLAY,
  // Tools and mode: clamped to the lead (R6, R7).
  mode: CLAMP,
  tools: CLAMP,
  "no-tools": CLAMP,
  // Plugins (R2, R3, R4).
  "disable-plugin": INHERIT,
  "enable-plugin": INHERIT,
  "no-agents-md": INHERIT,
  "no-plugin-prompts": INHERIT,
  "plugin-prompts": INHERIT,
  "no-plugin-prompts-for": INHERIT,
  "plugin-prompts-for": INHERIT,
  "dry-run": no("a worker must send its request"),
  platform: UNREVIEWED,
  "trust-hooks": no("sets an env value, and the worker inherits process.env"),
  "host-mode": no("the worker runs as a subagent, not a host mode"),
  bare: INHERIT,
  // Session.
  "session-id": SESSION,
  resume: SESSION,
  "resume-same-sid": SESSION,
  "startup-profile": no("the spawn plan passes the lead profile path itself"),
  // System prompt (R1).
  ...systemPromptEntries,
  "unsafe-system-prompt-overrides": INHERIT,
  "append-system-prompt": no("not a StartupProfile field"),
  "append-system-prompt-file": no("not a StartupProfile field"),
  // Debug.
  debug: no("lead diagnostics, the worker writes its own session log"),
  verbose: DISPLAY,
  "skip-quota": UNREVIEWED,
  // Command forms.
  help: INFO,
  version: INFO,
  "list-models": INFO,
  "list-models-live": INFO,
  "list-providers": INFO,
  "list-flags": INFO,
  "list-plugins": INFO,
  "list-spinners": INFO,
  sessions: INFO,
  usage: INFO,
  dump: INFO,
  login: INFO,
  logout: INFO,
  "auth-status": INFO,
}
