/**
 * Only the interactive REPL loads plugin `ui` modules (S35).
 *
 * The test spawns the real CLI `main()` (through
 * `fixtures/resume-kill-child.ts`, with its scripted provider) with one
 * project plugin. The plugin has a `ui.setup` module and a `ui` live-area
 * slot. Each writes a mark file when it is imported. The plugin also has a
 * headless host mode. ACP host mode
 * and `--output-format json` must not import the `ui` module. The REPL
 * must import it (the control that proves the probe works).
 *
 * @module startup/plugin-ui-routes.test
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { cleanSpawnEnv } from "../e2e/clean-spawn-env.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { tempHomeSpawnEnv } from "../test-utils/temp-home-env.ts"

// The json route uses the anthropic-messages surface of this provider.
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")

const CLI_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CLI_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const DIR = mkdtempSync(join(TMP_ROOT, "plugin-ui-routes-"))
const HOME_DIR = join(DIR, "home")
const PROJECT = join(DIR, "project")
const PLUGIN = join(PROJECT, ".agents", "minimal-agent", "plugins", "ui-probe")
const MARK = join(DIR, "ui-imported.txt")
const CHILD = join(import.meta.dir, "fixtures", "resume-kill-child.ts")

mkdirSync(HOME_DIR, { recursive: true })
mkdirSync(PLUGIN, { recursive: true })
writeFileSync(
  join(PLUGIN, "manifest.json"),
  JSON.stringify({
    id: "ui-probe",
    name: "UI probe",
    version: "0.1.0",
    description: "Test plugin: its ui module marks each import.",
    permissions: ["hostMode:stdio"],
    headless: {
      hostModes: [
        {
          id: "ui-probe",
          description: "Ends at once.",
          entry: { type: "module", path: "./host-mode.ts", export: "default" },
          permissions: ["hostMode:stdio"],
        },
      ],
    },
    ui: {
      setup: { type: "module", path: "./setup.ts" },
      liveAreaSlots: [
        { id: "probe", handler: { type: "module", path: "./slot.ts", export: "default" } },
      ],
    },
  }),
)
writeFileSync(join(PLUGIN, "host-mode.ts"), "export default async () => 0\n")
writeFileSync(
  join(PLUGIN, "setup.ts"),
  'import { appendFileSync } from "node:fs"\n' +
    'appendFileSync(process.env.UI_PROBE_MARK ?? "", "setup\\n")\n' +
    "export default async () => {}\n",
)
writeFileSync(
  join(PLUGIN, "slot.ts"),
  'import { appendFileSync } from "node:fs"\n' +
    'appendFileSync(process.env.UI_PROBE_MARK ?? "", "imported\\n")\n' +
    "export default async () => null\n",
)

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

async function runCli(args: string[]) {
  rmSync(MARK, { force: true })
  const p = Bun.spawn(["bun", "run", CHILD, "--skip-quota", "--formatter", "cat", ...args], {
    cwd: PROJECT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    env: {
      ...cleanSpawnEnv(),
      ...tempHomeSpawnEnv(),
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_TRANSPORT: "test",
      MINIMAL_AGENT_PROVIDER: "opencode-go",
      MINIMAL_AGENT_MODEL: "qwen3.7-plus",
      MINIMAL_AGENT_NO_LIVE_AREA: "1",
      HOME: HOME_DIR,
      MINIMAL_AGENT_HOME: join(HOME_DIR, ".minimal-agent"),
      RESUME_TEST_LOG: join(DIR, "requests.log"),
      RESUME_TEST_MARK: join(DIR, "bash-mark.txt"),
      RESUME_TEST_KILL_AT_ROUND: "0",
      UI_PROBE_MARK: MARK,
    },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { exitCode, stdout, stderr, imported: existsSync(MARK) ? readFileSync(MARK, "utf8") : "" }
}

describe.skipIf(!HAVE_PROVIDER)("plugin ui modules load only for the REPL (S35)", () => {
  it("the REPL imports the ui module (control)", async () => {
    const run = await runCli([])
    expect(run.exitCode).toBe(0)
    expect(run.imported).toBe("setup\nimported\n")
  }, 60000)

  it("--host-mode imports no ui module", async () => {
    const run = await runCli(["--host-mode", "ui-probe"])
    expect(run.stderr).not.toContain("fatal")
    expect(run.exitCode).toBe(0)
    expect(run.imported).toBe("")
  }, 60000)

  it("--output-format json imports no ui module", async () => {
    const run = await runCli(["-p", "go", "--output-format", "json"])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('"type":"turn_completed"')
    expect(run.imported).toBe("")
  }, 60000)
})
