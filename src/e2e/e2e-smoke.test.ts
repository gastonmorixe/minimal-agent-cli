import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_PRESENTATION } from "../plugins-ui/tool-presentation.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"
import { cleanSpawnEnv } from "./clean-spawn-env.ts"

// These tests boot the real CLI with the opencode-go provider plugin from the
// sibling plugins repo. On a bare core checkout (core CI) it is absent, so
// they skip (see test-utils/sibling-repo.ts). The umbrella checkout runs them.
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

describe("CLI smoke", () => {
  // The test limit matches the spawn ceiling. A real `bun` spawn can wait
  // for a CPU much longer than the default 5 s limit on a busy machine.
  it("prints help within budget without auth or network", async () => {
    const p = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      // Generous spawn ceiling so the subprocess isn't SIGKILLed under heavy
      // parallel test load (the timing budget is asserted separately below).
      timeout: 20000,
    })
    expect(await p.exited).toBe(0)
    // The budget is CPU time of the child, not wall-clock time. Wall-clock
    // time grows with machine load. CPU time stays near 0.2 s, and a help
    // path that boots plugins or the network would use much more.
    const cpuMicros = p.resourceUsage()?.cpuTime.total ?? 0n
    expect(cpuMicros).toBeGreaterThan(0n)
    expect(cpuMicros).toBeLessThan(2_000_000n)
  }, 20000)

  it.skipIf(!HAVE_PROVIDER)(
    "starts, sends a one-shot prompt, and exits without external network",
    async () => {
      const p = Bun.spawn(
        [
          "bun",
          "run",
          "src/index.ts",
          "--skip-quota",
          // Force the startup tree on so the assertions below can verify
          // its contents — non-interactive mode hides it by default. The
          // model/provider default to the registry default; the boot path is
          // what this test pins, not a specific vendor.
          "--header",
          "--prompt",
          "Reply with exactly: PONG",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          // Generous ceiling so the child isn't SIGKILLed under parallel load.
          timeout: 20000,
          env: {
            ...cleanSpawnEnv(),
            NODE_ENV: "test",
            MINIMAL_AGENT_TEST_AUTH: "1",
            MINIMAL_AGENT_TRANSPORT: "test",
            MINIMAL_AGENT_TEST_RESPONSE: "PONG",
            // Pin a registered, token-clean provider/model so the boot path is
            // deterministic. Without this, the canonical gate (`env -u
            // MINIMAL_AGENT_PROVIDER -u MINIMAL_AGENT_MODEL bun run check`) on a
            // machine with multiple credentialed providers dies "multiple
            // provider credentials found" before the CLI ever answers. opencode-go
            // (surface "anthropic-messages", so it decodes the test transport)
            // + qwen3.7-plus are neither vendor-token-flagged by the
            // provider-decoupling ratchet nor ambiguous at selection time. Same
            // pin as src/output-mode.e2e.test.ts.
            MINIMAL_AGENT_PROVIDER: "opencode-go",
            MINIMAL_AGENT_MODEL: "qwen3.7-plus",
          },
        },
      )

      const [exitCode, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(exitCode).toBe(0)
      expect(stdout).toContain("PONG")
      expect(stderr).toContain("minimal-agent")
      expect(stderr).toContain("oauth")
      // The startup tree renders a `model` row (the registry default); pin its
      // presence without naming a vendor.
      expect(stderr).toMatch(/model\s/)
      expect(stderr).not.toContain("cache anomaly")
      // Non-interactive defaults: ASK mode is auto-applied. The mode row
      // is only printed when the header is shown — which it is here via
      // `--header` — so verifying it pins both behaviors at once. ANSI
      // color codes sit between the "mode" label and the "ASK" value, so
      // strip them before matching.
      //
      // Asserts on `ASK` (the manifest's `label`), not `ask` (the lowercase
      // id) — the startup row aligns with the prompt prefix the user sees
      // a moment later (`ASK ❯ `). See `src/index.ts` mode-row site.
      const stderrPlain = stderr.replace(/\u001b\[[0-9;]*m/g, "")
      expect(stderrPlain).toMatch(/mode\s+ASK/)
      // The `tools` row shows the CLI icon of each tool (S41). Core tool
      // definitions carry no icon (S29), so a bare-name row means the banner
      // skipped the CLI presentation map.
      const toolsRow = stderrPlain.split("\n").find((l) => /^\s*[│╰] tools\s/.test(l))
      expect(toolsRow).toBeDefined()
      const chunks = (toolsRow ?? "").replace(/^\s*[│╰] tools\s+/, "").split(" · ")
      const decorated = chunks.filter((ch) => {
        const name = ch.slice(ch.lastIndexOf(" ") + 1)
        const icon = TOOL_PRESENTATION.get(name)?.icon
        if (!icon) return false
        expect(ch).toBe(`${icon} ${name}`)
        return true
      })
      expect(decorated.length).toBeGreaterThan(0)
    },
  )

  it.skipIf(!HAVE_PROVIDER)(
    "hides the startup tree by default in non-interactive mode",
    async () => {
      const isolatedHome = mkdtempSync(join(tmpdir(), "ma-smoke-home-"))
      const p = Bun.spawn(
        ["bun", "run", "src/index.ts", "--skip-quota", "--prompt", "Reply with exactly: PONG"],
        {
          stdout: "pipe",
          stderr: "pipe",
          // Generous ceiling so the child isn't SIGKILLed under parallel load.
          timeout: 20000,
          env: {
            ...cleanSpawnEnv(),
            ...tempHomeSpawnEnv(),
            NODE_ENV: "test",
            MINIMAL_AGENT_TEST_AUTH: "1",
            MINIMAL_AGENT_TRANSPORT: "test",
            MINIMAL_AGENT_TEST_RESPONSE: "PONG",
            // Isolate plugin discovery from the developer's real ~/.minimal-agent
            // and ~/.agents plugin dirs. Without this, the loader warns about the
            // user's local plugins and the warning PATH (…/.minimal-agent/plugins/…)
            // leaks the substring "minimal-agent" into stderr, tripping the
            // negative assertion below on a real machine. (MINIMAL_AGENT_DISABLE_PLUGINS
            // takes plugin ids, so it cannot do this.) Provider plugins still come
            // from the sibling repo.
            HOME: isolatedHome,
            MINIMAL_AGENT_HOME: join(isolatedHome, ".minimal-agent"),
            // Pin a registered, token-clean provider/model so the boot path is
            // deterministic under the canonical `env -u MINIMAL_AGENT_PROVIDER -u
            // MINIMAL_AGENT_MODEL` gate on a multi-credential machine. See the
            // sibling test above for the full rationale.
            MINIMAL_AGENT_PROVIDER: "opencode-go",
            MINIMAL_AGENT_MODEL: "qwen3.7-plus",
          },
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])
      expect(exitCode).toBe(0)
      expect(stdout).toContain("PONG")
      // Banner / tree rows are suppressed by default in non-interactive.
      expect(stderr).not.toContain("minimal-agent")
      expect(stderr).not.toMatch(/^\s*│/m)
      expect(stderr).not.toMatch(/^\s*╭/m)
    },
  )
})
