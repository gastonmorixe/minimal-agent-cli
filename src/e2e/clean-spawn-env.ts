/**
 * Child env for e2e spawns: the parent env without any `MINIMAL_AGENT_*` key.
 * A developer shell can set such keys (for example a disabled plugin list).
 * They change the child output and make a spawn test depend on the shell.
 * A test adds back only the keys it sets itself.
 *
 * @module e2e/clean-spawn-env
 */

/** Copy `env` and drop every key that starts with `MINIMAL_AGENT_`. */
export function cleanSpawnEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MINIMAL_AGENT_")) out[key] = value
  }
  return out
}
