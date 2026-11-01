/**
 * Golden for the REPL tool transcript rows (spec S24, S29). Each case runs
 * one real tool call through the CLI tool transcript path and pins the
 * exact rows the REPL writes, plus the model-facing `content`. The golden
 * was recorded while core still built the rows. The CLI builds them now,
 * and the bytes must not change.
 *
 * Set `UPDATE_TOOL_TRANSCRIPT_GOLDEN=1` to write a new golden file. Do this
 * only for an intended change of the REPL output.
 */

import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolTimeTracker } from "@minimal-agent/core/host/tool-time"
import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import { ModeManager } from "@minimal-agent/core/host-kit/modes"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import type { LifecyclePort } from "@minimal-agent/core/sdk/lifecycle"

import { TOOL_PRESENTATION } from "../../plugins-ui/tool-presentation.ts"
import type { CodeHighlighter } from "../formatter/mdstream-code-highlighter.ts"
import { createReplToolView } from "./tool-view.ts"

const GOLDEN_PATH = join(import.meta.dirname, "tool-transcript.golden.json")
const UPDATE = process.env.UPDATE_TOOL_TRANSCRIPT_GOLDEN === "1"

const root = mkdtempSync(join(tmpdir(), "cli-tool-transcript-golden-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A header time that never moves, so the golden is stable. */
class FixedTimeTracker extends ToolTimeTracker {
  override format(): string {
    return "12:00:00"
  }
}

/** A highlighter that wraps each line in one fixed color. */
const HIGHLIGHTER: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
      .join("\n")
  },
  close: async () => {},
}

/** A plugin with one deferred-header tool and one early-header tool. */
async function loadProbePlugin(): Promise<PluginLoader> {
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "probe")
  mkdirSync(dir, { recursive: true })
  const tool = (id: string, name: string, path: string) => ({
    id,
    trigger: {
      type: "tool",
      tool: {
        name,
        description: "probe",
        input_schema: { type: "object", properties: { url: { type: "string" } } },
        explicitName: true,
      },
    },
    handler: { type: "module", path, export: "default" },
    interactive: false,
  })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "probe",
      name: "probe",
      version: "0.1.0",
      description: "t",
      headless: {
        tools: [tool("task", "Task", "./task.ts"), tool("fetch", "Fetch", "./fetch.ts")],
      },
    }),
  )
  writeFileSync(
    join(dir, "task.ts"),
    `export default async () => ({
  kind: "tool_result",
  content: "added 2 tasks",
  display: "[ ] one\\n[ ] two",
  displayHeader: "+ added 2 tasks",
  displayFooter: "0/2 done",
  suppressToolTime: true,
})`,
  )
  writeFileSync(
    join(dir, "fetch.ts"),
    `export default async () => ({
  kind: "tool_result",
  content: Array.from({ length: 40 }, (_, i) => "page line " + i).join("\\n"),
})`,
  )
  return PluginLoader.load({ roots: { embedded: [pluginsDir] }, logger: () => {} })
}

interface CaseOptions {
  loader?: PluginLoader | null
  modeManager?: ModeManager | null
  lifecycle?: LifecyclePort
  highlighter?: CodeHighlighter | null
}

/**
 * Build the executor the REPL uses. This is the one part of the test that
 * follows the wiring. The golden bytes stay fixed.
 */
function replExecutor(rows: string[], opts: CaseOptions): ToolExecutorAdapter {
  return new ToolExecutorAdapter({
    toolView: createReplToolView({
      writeTranscript: (line) => rows.push(line),
      presentation: TOOL_PRESENTATION,
      toolTimeTracker: new FixedTimeTracker(),
      codeHighlighter: opts.highlighter ?? null,
      columns: () => 100,
    }),
    loader: opts.loader ?? null,
    modeManager: opts.modeManager ?? null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    toolEnv: { values: () => ({ env: { COLUMNS: "100", LINES: "40" } }) },
  })
}

interface CaseResult {
  rows: string[]
  content: unknown
  isError: boolean
}

async function runCase(
  name: string,
  input: Record<string, unknown>,
  opts: CaseOptions = {},
): Promise<CaseResult> {
  const rows: string[] = []
  const result = await replExecutor(rows, opts).execute({
    type: "tool_use",
    id: `call-${name}`,
    name,
    input,
  })
  const scrub = (s: string) => s.split(root).join("<ROOT>")
  return {
    rows: rows.map(scrub),
    content: typeof result.content === "string" ? scrub(result.content) : result.content,
    isError: result.isError,
  }
}

function writeFixture(name: string, text: string): string {
  const path = join(root, name)
  writeFileSync(path, text)
  return path
}

describe("REPL tool transcript golden (S24, S29)", () => {
  it("keeps the exact rows and model content of each tool case", async () => {
    const loader = await loadProbePlugin()
    const askMode = new ModeManager(
      [
        {
          id: "ask",
          label: "ASK",
          permissions: [
            { tool: "*", allow: true },
            { tool: "Bash", allow: false },
          ],
        },
      ],
      "ask",
      "dark",
      () => new Date(2026, 4, 22, 17, 52, 30),
    )
    const tsFile = writeFixture("example.ts", "const x: number = 1\nreturn x\n")
    const editFile = writeFixture("edit.ts", "alpha\nbeta\ngamma\n")
    const editHlFile = writeFixture("edit-hl.ts", "one\ntwo\nthree\n")
    const diagFile = writeFixture("diag.ts", "let a = 1\n")

    const cases: Record<string, CaseResult> = {}
    cases["bash-stream"] = await runCase("Bash", { command: "printf 'one\\ntwo\\nthree\\n'" })
    cases["bash-long"] = await runCase("Bash", { command: "seq 1 30" })
    cases["bash-empty"] = await runCase("Bash", { command: "true" })
    cases["bash-error"] = await runCase("Bash", { command: "echo oops >&2; exit 3" })
    cases["read-plain"] = await runCase("Read", { file_path: tsFile })
    cases["read-highlight"] = await runCase(
      "Read",
      { file_path: tsFile },
      { highlighter: HIGHLIGHTER },
    )
    cases["edit-diff"] = await runCase("Edit", {
      file_path: editFile,
      old_string: "beta",
      new_string: "BETA",
    })
    cases["edit-diff-highlight"] = await runCase(
      "Edit",
      { file_path: editHlFile, old_string: "two", new_string: "TWO" },
      { highlighter: HIGHLIGHTER },
    )
    cases["write-new"] = await runCase("Write", {
      file_path: join(root, "new.txt"),
      content: "fresh\nfile\n",
    })
    cases["input-error"] = await runCase("Read", {})
    cases["policy-deny"] = await runCase(
      "Bash",
      { command: "echo never" },
      { lifecycle: { beforeTool: async () => ({ action: "deny", reason: "blocked here" }) } },
    )
    cases["mode-refusal"] = await runCase(
      "Bash",
      { command: "echo never" },
      { modeManager: askMode },
    )
    cases["mode-tool"] = await runCase("Mode", {}, { modeManager: askMode })
    cases.diagnostics = await runCase(
      "Edit",
      { file_path: diagFile, old_string: "let a", new_string: "const a" },
      {
        lifecycle: {
          afterTool: async (payload) => ({
            ...payload,
            findings: [
              {
                severity: "warning",
                message: "a is unused",
                line: 1,
                source: "lint",
              },
            ],
            notes: ["a is unused"],
          }),
        },
      },
    )
    cases["plugin-deferred"] = await runCase("Task", {}, { loader })
    cases["plugin-early"] = await runCase("Fetch", { url: "https://example.com/a" }, { loader })

    const actual = `${JSON.stringify(cases, null, 2)}\n`
    if (UPDATE || !existsSync(GOLDEN_PATH)) writeFileSync(GOLDEN_PATH, actual)
    expect(actual).toBe(readFileSync(GOLDEN_PATH, "utf8"))
  }, 30_000)
})
