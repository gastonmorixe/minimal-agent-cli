/**
 * Frozen OLD routing of every built-in argv form (SPEC-HELP plan M-13a,
 * part 4). Generated once from cli 0e2a62e: `normalizeArgs` then
 * `parseCliOptions` (empty config, empty env) then `planCommand` then
 * `extractSubcommandInputs` (the reads of the `run-subcommand.ts` switch).
 *
 * Do not edit a row by hand to make a test pass. A changed row is a
 * behavior change: it needs a lead decision and a CHANGELOG note. The
 * parity test checks that the old code still gives each row, and that the
 * new route resolver gives the same command.
 *
 * Each argv is listed twice: as is, and with the global flag `--debug`
 * added at the end.
 *
 * @module host/startup/dispatch/invocation-parity.table
 */

import type { SubcommandInputs } from "../subcommand-inputs.ts"

/** One frozen row: raw argv and the old handler input. */
export interface ParityRow {
  readonly argv: readonly string[]
  readonly old: SubcommandInputs
}

/** The frozen rows, in plan part 4 order. */
export const PARITY_ROWS: readonly ParityRow[] = [
  {
    argv: ["sessions", "dump", "abc123"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["sessions", "dump", "abc123", "--debug"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["sessions", "dump", "last", "--dump-format", "json", "--dump-paths"],
    old: { command: "dump", target: "last", format: "json", paths: true },
  },
  {
    argv: ["sessions", "dump", "last", "--dump-format", "json", "--dump-paths", "--debug"],
    old: { command: "dump", target: "last", format: "json", paths: true },
  },
  { argv: ["sessions", "dump"], old: { command: "run" } },
  {
    argv: ["sessions", "dump", "--debug"],
    old: { command: "dump", target: "--debug", format: "md", paths: false },
  },
  {
    argv: ["--dump", "abc123"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["--dump", "abc123", "--debug"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["--dump", "abc123", "--dump-format", "json", "--dump-paths"],
    old: { command: "dump", target: "abc123", format: "json", paths: true },
  },
  {
    argv: ["--dump", "abc123", "--dump-format", "json", "--dump-paths", "--debug"],
    old: { command: "dump", target: "abc123", format: "json", paths: true },
  },
  {
    argv: ["--dump=abc123", "--dump-format=json"],
    old: { command: "dump", target: "abc123", format: "json", paths: false },
  },
  {
    argv: ["--dump=abc123", "--dump-format=json", "--debug"],
    old: { command: "dump", target: "abc123", format: "json", paths: false },
  },
  { argv: ["sessions"], old: { command: "sessions" } },
  { argv: ["sessions", "--debug"], old: { command: "sessions" } },
  { argv: ["sessions", "list"], old: { command: "sessions" } },
  { argv: ["sessions", "list", "--debug"], old: { command: "sessions" } },
  { argv: ["sessions", "auth"], old: { command: "sessions", query: "auth" } },
  { argv: ["sessions", "auth", "--debug"], old: { command: "sessions", query: "auth" } },
  { argv: ["--sessions"], old: { command: "sessions" } },
  { argv: ["--sessions", "--debug"], old: { command: "sessions" } },
  { argv: ["--sessions", "auth"], old: { command: "sessions", query: "auth" } },
  { argv: ["--sessions", "auth", "--debug"], old: { command: "sessions", query: "auth" } },
  { argv: ["--sessions=auth"], old: { command: "sessions", query: "auth" } },
  { argv: ["--sessions=auth", "--debug"], old: { command: "sessions", query: "auth" } },
  { argv: ["--session"], old: { command: "sessions" } },
  { argv: ["--session", "--debug"], old: { command: "sessions" } },
  { argv: ["--list-sessions", "auth"], old: { command: "sessions", query: "auth" } },
  { argv: ["--list-sessions", "auth", "--debug"], old: { command: "sessions", query: "auth" } },
  { argv: ["usage"], old: { command: "usage" } },
  { argv: ["usage", "--debug"], old: { command: "usage" } },
  { argv: ["usage", "today"], old: { command: "usage", period: "today" } },
  { argv: ["usage", "today", "--debug"], old: { command: "usage", period: "today" } },
  { argv: ["--usage"], old: { command: "usage" } },
  { argv: ["--usage", "--debug"], old: { command: "usage" } },
  { argv: ["--usage", "ytd"], old: { command: "usage", period: "ytd" } },
  { argv: ["--usage", "ytd", "--debug"], old: { command: "usage", period: "ytd" } },
  { argv: ["--usage=ytd"], old: { command: "usage", period: "ytd" } },
  { argv: ["--usage=ytd", "--debug"], old: { command: "usage", period: "ytd" } },
  { argv: ["--usage-stats"], old: { command: "usage" } },
  { argv: ["--usage-stats", "--debug"], old: { command: "usage" } },
  { argv: ["flags"], old: { command: "list-flags" } },
  { argv: ["flags", "--debug"], old: { command: "list-flags" } },
  { argv: ["flags", "list"], old: { command: "list-flags" } },
  { argv: ["flags", "list", "--debug"], old: { command: "list-flags" } },
  { argv: ["--list-flags"], old: { command: "list-flags" } },
  { argv: ["--list-flags", "--debug"], old: { command: "list-flags" } },
  { argv: ["--flags"], old: { command: "list-flags" } },
  { argv: ["--flags", "--debug"], old: { command: "list-flags" } },
  { argv: ["--list-flag"], old: { command: "list-flags" } },
  { argv: ["--list-flag", "--debug"], old: { command: "list-flags" } },
  { argv: ["spinners"], old: { command: "list-spinners" } },
  { argv: ["spinners", "--debug"], old: { command: "list-spinners" } },
  { argv: ["spinners", "list"], old: { command: "list-spinners" } },
  { argv: ["spinners", "list", "--debug"], old: { command: "list-spinners" } },
  { argv: ["--list-spinners"], old: { command: "list-spinners" } },
  { argv: ["--list-spinners", "--debug"], old: { command: "list-spinners" } },
  { argv: ["--spinners"], old: { command: "list-spinners" } },
  { argv: ["--spinners", "--debug"], old: { command: "list-spinners" } },
  { argv: ["--list-spinner"], old: { command: "list-spinners" } },
  { argv: ["--list-spinner", "--debug"], old: { command: "list-spinners" } },
  { argv: ["plugins"], old: { command: "list-plugins", cliArgs: ["--list-plugins"] } },
  {
    argv: ["plugins", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--debug"] },
  },
  { argv: ["plugins", "list"], old: { command: "list-plugins", cliArgs: ["--list-plugins"] } },
  {
    argv: ["plugins", "list", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--debug"] },
  },
  { argv: ["--list-plugins"], old: { command: "list-plugins", cliArgs: ["--list-plugins"] } },
  {
    argv: ["--list-plugins", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--debug"] },
  },
  { argv: ["--plugins"], old: { command: "list-plugins", cliArgs: ["--list-plugins"] } },
  {
    argv: ["--plugins", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--debug"] },
  },
  { argv: ["--list-plugin"], old: { command: "list-plugins", cliArgs: ["--list-plugins"] } },
  {
    argv: ["--list-plugin", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--debug"] },
  },
  {
    argv: ["plugins", "--disable-plugin", "acp"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--disable-plugin", "acp"] },
  },
  {
    argv: ["plugins", "--disable-plugin", "acp", "--debug"],
    old: {
      command: "list-plugins",
      cliArgs: ["--list-plugins", "--disable-plugin", "acp", "--debug"],
    },
  },
  { argv: ["models"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["models", "--debug"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["models", "list"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["models", "list", "--debug"], old: { command: "list-models", printFormat: "text" } },
  {
    argv: ["models", "openai"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["models", "openai", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  { argv: ["providers", "models"], old: { command: "list-models", printFormat: "text" } },
  {
    argv: ["providers", "models", "--debug"],
    old: { command: "list-models", printFormat: "text" },
  },
  {
    argv: ["providers", "models", "openai"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["providers", "models", "openai", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["provider", "openai", "models"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["provider", "openai", "models", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["provider", "openai", "models", "--print-format", "json"],
    old: { command: "list-models", provider: "openai", printFormat: "json" },
  },
  {
    argv: ["provider", "openai", "models", "--print-format", "json", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "json" },
  },
  { argv: ["--list-models"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["--list-models", "--debug"], old: { command: "list-models", printFormat: "text" } },
  {
    argv: ["--list-models", "openai"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["--list-models", "openai", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["--list-models=openai"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  {
    argv: ["--list-models=openai", "--debug"],
    old: { command: "list-models", provider: "openai", printFormat: "text" },
  },
  { argv: ["--models"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["--models", "--debug"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["--list-model"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["--list-model", "--debug"], old: { command: "list-models", printFormat: "text" } },
  { argv: ["models-live"], old: { command: "list-models-live" } },
  { argv: ["models-live", "--debug"], old: { command: "list-models-live" } },
  { argv: ["models-live", "list"], old: { command: "list-models-live" } },
  { argv: ["models-live", "list", "--debug"], old: { command: "list-models-live" } },
  { argv: ["providers", "models-live"], old: { command: "list-models-live" } },
  { argv: ["providers", "models-live", "--debug"], old: { command: "list-models-live" } },
  {
    argv: ["providers", "models-live", "openai"],
    old: { command: "list-models-live", provider: "openai" },
  },
  {
    argv: ["providers", "models-live", "openai", "--debug"],
    old: { command: "list-models-live", provider: "openai" },
  },
  {
    argv: ["provider", "openai", "models-live"],
    old: { command: "list-models-live", provider: "openai" },
  },
  {
    argv: ["provider", "openai", "models-live", "--debug"],
    old: { command: "list-models-live", provider: "openai" },
  },
  { argv: ["--list-models-live"], old: { command: "list-models-live" } },
  { argv: ["--list-models-live", "--debug"], old: { command: "list-models-live" } },
  {
    argv: ["--list-models-live", "openai"],
    old: { command: "list-models-live", provider: "openai" },
  },
  {
    argv: ["--list-models-live", "openai", "--debug"],
    old: { command: "list-models-live", provider: "openai" },
  },
  { argv: ["--models-live"], old: { command: "list-models-live" } },
  { argv: ["--models-live", "--debug"], old: { command: "list-models-live" } },
  { argv: ["--list-model-live"], old: { command: "list-models-live" } },
  { argv: ["--list-model-live", "--debug"], old: { command: "list-models-live" } },
  { argv: ["providers"], old: { command: "list-providers" } },
  { argv: ["providers", "--debug"], old: { command: "list-providers" } },
  { argv: ["providers", "list"], old: { command: "list-providers" } },
  { argv: ["providers", "list", "--debug"], old: { command: "list-providers" } },
  { argv: ["providers", "other"], old: { command: "list-providers" } },
  { argv: ["providers", "other", "--debug"], old: { command: "list-providers" } },
  { argv: ["provider", "openai"], old: { command: "list-providers" } },
  { argv: ["provider", "openai", "--debug"], old: { command: "list-providers" } },
  { argv: ["provider", "openai", "other"], old: { command: "list-providers" } },
  { argv: ["provider", "openai", "other", "--debug"], old: { command: "list-providers" } },
  { argv: ["--list-providers"], old: { command: "list-providers" } },
  { argv: ["--list-providers", "--debug"], old: { command: "list-providers" } },
  { argv: ["--providers"], old: { command: "list-providers" } },
  { argv: ["--providers", "--debug"], old: { command: "list-providers" } },
  { argv: ["login"], old: { command: "login" } },
  { argv: ["login", "--debug"], old: { command: "login" } },
  { argv: ["login", "openai"], old: { command: "login", providerId: "openai" } },
  { argv: ["login", "openai", "--debug"], old: { command: "login", providerId: "openai" } },
  {
    argv: ["login", "openai", "oauth"],
    old: { command: "login", providerId: "openai", authMethod: "oauth" },
  },
  {
    argv: ["login", "openai", "oauth", "--debug"],
    old: { command: "login", providerId: "openai", authMethod: "oauth" },
  },
  { argv: ["providers", "login", "openai"], old: { command: "login", providerId: "openai" } },
  {
    argv: ["providers", "login", "openai", "--debug"],
    old: { command: "login", providerId: "openai" },
  },
  {
    argv: ["providers", "login", "openai", "api-key"],
    old: { command: "login", providerId: "openai", authMethod: "api-key" },
  },
  {
    argv: ["providers", "login", "openai", "api-key", "--debug"],
    old: { command: "login", providerId: "openai", authMethod: "api-key" },
  },
  { argv: ["provider", "openai", "login"], old: { command: "login", providerId: "openai" } },
  {
    argv: ["provider", "openai", "login", "--debug"],
    old: { command: "login", providerId: "openai" },
  },
  {
    argv: ["provider", "openai", "login", "oauth", "--name", "work", "--auth-method", "api-key"],
    old: { command: "login", providerId: "openai", authMethod: "oauth", credentialName: "work" },
  },
  {
    argv: [
      "provider",
      "openai",
      "login",
      "oauth",
      "--name",
      "work",
      "--auth-method",
      "api-key",
      "--debug",
    ],
    old: { command: "login", providerId: "openai", authMethod: "oauth", credentialName: "work" },
  },
  {
    argv: ["provider", "openai", "login", "--name", "work"],
    old: { command: "login", providerId: "openai", credentialName: "work" },
  },
  {
    argv: ["provider", "openai", "login", "--name", "work", "--debug"],
    old: { command: "login", providerId: "openai", credentialName: "work" },
  },
  {
    argv: ["--login", "--provider", "openai", "--email", "a@b.c"],
    old: { command: "login", loginHint: "a@b.c", providerId: "openai" },
  },
  {
    argv: ["--login", "--provider", "openai", "--email", "a@b.c", "--debug"],
    old: { command: "login", loginHint: "a@b.c", providerId: "openai" },
  },
  { argv: ["--login", "--email-hint", "a@b.c"], old: { command: "login", loginHint: "a@b.c" } },
  {
    argv: ["--login", "--email-hint", "a@b.c", "--debug"],
    old: { command: "login", loginHint: "a@b.c" },
  },
  { argv: ["--login", "--name", "work"], old: { command: "login", credentialName: "work" } },
  {
    argv: ["--login", "--name", "work", "--debug"],
    old: { command: "login", credentialName: "work" },
  },
  { argv: ["login", "--auth-method=oauth"], old: { command: "login", authMethod: "oauth" } },
  {
    argv: ["login", "--auth-method=oauth", "--debug"],
    old: { command: "login", authMethod: "oauth" },
  },
  { argv: ["logout"], old: { command: "logout" } },
  { argv: ["logout", "--debug"], old: { command: "logout" } },
  { argv: ["logout", "openai"], old: { command: "logout", providerId: "openai" } },
  { argv: ["logout", "openai", "--debug"], old: { command: "logout", providerId: "openai" } },
  { argv: ["providers", "logout", "openai"], old: { command: "logout", providerId: "openai" } },
  {
    argv: ["providers", "logout", "openai", "--debug"],
    old: { command: "logout", providerId: "openai" },
  },
  { argv: ["provider", "openai", "logout"], old: { command: "logout", providerId: "openai" } },
  {
    argv: ["provider", "openai", "logout", "--debug"],
    old: { command: "logout", providerId: "openai" },
  },
  { argv: ["--logout", "--provider", "openai"], old: { command: "logout", providerId: "openai" } },
  {
    argv: ["--logout", "--provider", "openai", "--debug"],
    old: { command: "logout", providerId: "openai" },
  },
  { argv: ["auth-status"], old: { command: "auth-status", verb: "status", table: false } },
  {
    argv: ["auth-status", "--debug"],
    old: { command: "auth-status", verb: "status", table: false },
  },
  {
    argv: ["auth-status", "--table"],
    old: { command: "auth-status", verb: "status", table: true },
  },
  {
    argv: ["auth-status", "--table", "--debug"],
    old: { command: "auth-status", verb: "status", table: true },
  },
  {
    argv: ["auth-status", "refresh", "work"],
    old: { command: "auth-status", verb: "refresh", credential: "work" },
  },
  {
    argv: ["auth-status", "refresh", "work", "--debug"],
    old: { command: "auth-status", verb: "refresh", credential: "work" },
  },
  {
    argv: ["auth-status", "refresh", "--name", "work", "--provider", "openai"],
    old: { command: "auth-status", verb: "refresh", credential: "work", providerId: "openai" },
  },
  {
    argv: ["auth-status", "refresh", "--name", "work", "--provider", "openai", "--debug"],
    old: { command: "auth-status", verb: "refresh", credential: "work", providerId: "openai" },
  },
  {
    argv: ["auth-status", "refresh"],
    old: {
      command: "auth-status",
      verb: "refresh",
      error: "auth-status refresh requires <credential>",
    },
  },
  {
    argv: ["auth-status", "refresh", "--debug"],
    old: {
      command: "auth-status",
      verb: "refresh",
      error: "auth-status refresh requires <credential>",
    },
  },
  {
    argv: ["auth-status", "refresh-all", "--parallel", "8"],
    old: { command: "auth-status", verb: "refresh-all", parallel: 8 },
  },
  {
    argv: ["auth-status", "refresh-all", "--parallel", "8", "--debug"],
    old: { command: "auth-status", verb: "refresh-all", parallel: 8 },
  },
  { argv: ["auth-status", "plan"], old: { command: "auth-status", verb: "plan", parallel: 4 } },
  {
    argv: ["auth-status", "plan", "--debug"],
    old: { command: "auth-status", verb: "plan", parallel: 4 },
  },
  {
    argv: ["auth-status", "plan", "work", "--all", "--table", "--parallel", "2"],
    old: {
      command: "auth-status",
      verb: "plan",
      credential: "work",
      table: true,
      all: true,
      parallel: 2,
    },
  },
  {
    argv: ["auth-status", "plan", "work", "--all", "--table", "--parallel", "2", "--debug"],
    old: {
      command: "auth-status",
      verb: "plan",
      credential: "work",
      table: true,
      all: true,
      parallel: 2,
    },
  },
  {
    argv: ["auth-status", "plan", "--name", "work"],
    old: { command: "auth-status", verb: "plan", credential: "work", parallel: 4 },
  },
  {
    argv: ["auth-status", "plan", "--name", "work", "--debug"],
    old: { command: "auth-status", verb: "plan", credential: "work", parallel: 4 },
  },
  { argv: ["auth-status", "prune"], old: { command: "auth-status", verb: "prune", parallel: 4 } },
  {
    argv: ["auth-status", "prune", "--debug"],
    old: { command: "auth-status", verb: "prune", parallel: 4 },
  },
  {
    argv: ["auth-status", "prune", "--dry-run", "--force", "--table"],
    old: {
      command: "auth-status",
      verb: "prune",
      dryRun: true,
      force: true,
      table: true,
      parallel: 4,
    },
  },
  {
    argv: ["auth-status", "prune", "--dry-run", "--force", "--table", "--debug"],
    old: {
      command: "auth-status",
      verb: "prune",
      dryRun: true,
      force: true,
      table: true,
      parallel: 4,
    },
  },
  {
    argv: ["auth-status", "prune", "extra"],
    old: {
      command: "auth-status",
      verb: "prune",
      error: 'auth-status prune takes no credential argument (got "extra")',
    },
  },
  {
    argv: ["auth-status", "prune", "extra", "--debug"],
    old: {
      command: "auth-status",
      verb: "prune",
      error: 'auth-status prune takes no credential argument (got "extra")',
    },
  },
  { argv: ["--auth-status"], old: { command: "auth-status", verb: "status", table: false } },
  {
    argv: ["--auth-status", "--debug"],
    old: { command: "auth-status", verb: "status", table: false },
  },
  { argv: ["--auth-status", "plan"], old: { command: "auth-status", verb: "plan", parallel: 4 } },
  {
    argv: ["--auth-status", "plan", "--debug"],
    old: { command: "auth-status", verb: "plan", parallel: 4 },
  },
  {
    argv: ["--auth-status", "refresh", "work"],
    old: { command: "auth-status", verb: "refresh", credential: "work" },
  },
  {
    argv: ["--auth-status", "refresh", "work", "--debug"],
    old: { command: "auth-status", verb: "refresh", credential: "work" },
  },
  {
    argv: ["auth-status", "--name", "refresh"],
    old: { command: "auth-status", verb: "refresh", credential: "refresh" },
  },
  {
    argv: ["auth-status", "--name", "refresh", "--debug"],
    old: { command: "auth-status", verb: "refresh", credential: "refresh" },
  },
  {
    argv: ["auth-status", "--parallel", "plan"],
    old: { command: "auth-status", verb: "plan", parallel: 4 },
  },
  {
    argv: ["auth-status", "--parallel", "plan", "--debug"],
    old: { command: "auth-status", verb: "plan", parallel: 4 },
  },
  { argv: ["--host-mode", "acp"], old: { command: "host-mode", id: "acp" } },
  { argv: ["--host-mode", "acp", "--debug"], old: { command: "host-mode", id: "acp" } },
  { argv: ["--host-mode=acp"], old: { command: "host-mode", id: "acp" } },
  { argv: ["--host-mode=acp", "--debug"], old: { command: "host-mode", id: "acp" } },
  { argv: ["--host-mode", "acp", "extra", "args"], old: { command: "host-mode", id: "acp" } },
  {
    argv: ["--host-mode", "acp", "extra", "args", "--debug"],
    old: { command: "host-mode", id: "acp" },
  },
  { argv: [], old: { command: "run" } },
  { argv: ["--debug"], old: { command: "run" } },
  { argv: ["hello"], old: { command: "run" } },
  { argv: ["hello", "--debug"], old: { command: "run" } },
  { argv: ["-"], old: { command: "run" } },
  { argv: ["-", "--debug"], old: { command: "run" } },
  { argv: ["-p", "hi"], old: { command: "run" } },
  { argv: ["-p", "hi", "--debug"], old: { command: "run" } },
  { argv: ["--prompt", "hi"], old: { command: "run" } },
  { argv: ["--prompt", "hi", "--debug"], old: { command: "run" } },
  { argv: ["resume", "abc123"], old: { command: "run" } },
  { argv: ["resume", "abc123", "--debug"], old: { command: "run" } },
  { argv: ["resume-same", "abc123"], old: { command: "run" } },
  { argv: ["resume-same", "abc123", "--debug"], old: { command: "run" } },
  { argv: ["sessions", "resume", "abc123"], old: { command: "run" } },
  { argv: ["sessions", "resume", "abc123", "--debug"], old: { command: "run" } },
  { argv: ["sessions", "resume-same", "last"], old: { command: "run" } },
  { argv: ["sessions", "resume-same", "last", "--debug"], old: { command: "run" } },
  { argv: ["-r", "abc123"], old: { command: "run" } },
  { argv: ["-r", "abc123", "--debug"], old: { command: "run" } },
  { argv: ["plugin"], old: { command: "run" } },
  { argv: ["plugin", "--debug"], old: { command: "run" } },
  { argv: ["plugin", "--json"], old: { command: "run" } },
  { argv: ["plugin", "--json", "--debug"], old: { command: "run" } },
  { argv: ["plugin", "schedule"], old: { command: "run" } },
  { argv: ["plugin", "schedule", "--debug"], old: { command: "run" } },
  { argv: ["schedule"], old: { command: "run" } },
  { argv: ["schedule", "--debug"], old: { command: "run" } },
  { argv: ["schedule", "list"], old: { command: "run" } },
  { argv: ["schedule", "list", "--debug"], old: { command: "run" } },
  { argv: ["provider"], old: { command: "run" } },
  { argv: ["provider", "--debug"], old: { command: "run" } },
  { argv: ["--parallel", "8", "hello"], old: { command: "run" } },
  { argv: ["--parallel", "8", "hello", "--debug"], old: { command: "run" } },
  { argv: ["--parallel=8", "hello"], old: { command: "run" } },
  { argv: ["--parallel=8", "hello", "--debug"], old: { command: "run" } },
  { argv: ["-m", "x", "hello"], old: { command: "run" } },
  { argv: ["-m", "x", "hello", "--debug"], old: { command: "run" } },
  { argv: ["hello", "--sessions"], old: { command: "sessions" } },
  { argv: ["hello", "--sessions", "--debug"], old: { command: "sessions" } },
  {
    argv: ["resume", "abc123", "--list-models"],
    old: { command: "list-models", printFormat: "text" },
  },
  {
    argv: ["resume", "abc123", "--list-models", "--debug"],
    old: { command: "list-models", printFormat: "text" },
  },
  { argv: ["provider", "--list-flags"], old: { command: "list-flags" } },
  { argv: ["provider", "--list-flags", "--debug"], old: { command: "list-flags" } },
  { argv: ["login", "--list-models"], old: { command: "list-models", printFormat: "text" } },
  {
    argv: ["login", "--list-models", "--debug"],
    old: { command: "list-models", printFormat: "text" },
  },
  { argv: ["--sessions", "--usage"], old: { command: "sessions" } },
  { argv: ["--sessions", "--usage", "--debug"], old: { command: "sessions" } },
  {
    argv: ["--list-plugins", "--login"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--login"] },
  },
  {
    argv: ["--list-plugins", "--login", "--debug"],
    old: { command: "list-plugins", cliArgs: ["--list-plugins", "--login", "--debug"] },
  },
  { argv: ["--list-models", "--list-models-live"], old: { command: "list-models-live" } },
  {
    argv: ["--list-models", "--list-models-live", "--debug"],
    old: { command: "list-models-live" },
  },
  { argv: ["--sessions", "--logout"], old: { command: "sessions" } },
  { argv: ["--sessions", "--logout", "--debug"], old: { command: "sessions" } },
  { argv: ["--list-flags", "--login"], old: { command: "list-flags" } },
  { argv: ["--list-flags", "--login", "--debug"], old: { command: "list-flags" } },
  { argv: ["--login", "--logout", "--auth-status"], old: { command: "login" } },
  { argv: ["--login", "--logout", "--auth-status", "--debug"], old: { command: "login" } },
  { argv: ["--logout", "--auth-status"], old: { command: "logout" } },
  { argv: ["--logout", "--auth-status", "--debug"], old: { command: "logout" } },
  {
    argv: ["--dump", "abc123", "--sessions"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["--dump", "abc123", "--sessions", "--debug"],
    old: { command: "dump", target: "abc123", format: "md", paths: false },
  },
  {
    argv: ["--auth-status", "--host-mode", "acp"],
    old: { command: "auth-status", verb: "status", table: false },
  },
  {
    argv: ["--auth-status", "--host-mode", "acp", "--debug"],
    old: { command: "auth-status", verb: "status", table: false },
  },
]
