/**
 * Root command groups and FLAGS headings (plan M-8a, 2.2 and 2.3).
 *
 * `ROOT_GROUPS` gives the order and headings of root help COMMANDS (spec
 * 8.4). Each visible top-level command shows under the group that its
 * `CommandSpec.group` names. `members` lists the main paths of a group.
 *
 * @module cli/registry/groups
 */

import type { FlagGroup, RootGroup } from "./types.ts"

/** Root COMMANDS groups, in display order. */
export const ROOT_GROUPS: readonly RootGroup[] = [
  {
    id: "discover",
    title: "Discover",
    summary: "discover models and providers",
    members: [["providers"], ["providers", "models"], ["providers", "models-live"]],
  },
  {
    id: "history",
    title: "History",
    summary: "inspect or continue past work",
    members: [["sessions"], ["sessions", "dump"], ["resume"], ["usage"]],
  },
  {
    id: "auth",
    title: "Auth",
    summary: "manage provider credentials",
    members: [["provider", "login"], ["logout"], ["auth-status"]],
  },
  {
    id: "local",
    title: "Local",
    summary: "inspect the local installation",
    members: [["plugins"], ["flags"], ["spinners"], ["version"], ["update"], ["help"]],
  },
]

/** FLAGS headings, in display order. Each global `FlagSpec.group` names one id. */
export const FLAG_GROUPS: readonly FlagGroup[] = [
  { id: "model", title: "Model" },
  { id: "endpoint", title: "Generic endpoint" },
  { id: "output", title: "Output" },
  { id: "tools", title: "Tools and modes" },
  { id: "plugins", title: "Plugins" },
  { id: "session", title: "Session" },
  {
    id: "system-prompt",
    title: "System prompt",
    note: "override or omit individual system-prompt parts",
  },
  { id: "debug", title: "Debug" },
  { id: "help", title: "Help" },
  { id: "command-forms", title: "Command forms" },
]
