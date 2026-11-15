/**
 * Unit tests for the inline-script recogniser (`python -c '…'`, `node -e`,
 * `jq '…'`). The renderer side is covered in
 * `ui/tool-transcript/format.test.ts`.
 */

import { describe, expect, it } from "bun:test"

import { detectInlineScript, splitScriptStatements } from "./inline-script.ts"

describe("splitScriptStatements — depth-0 split", () => {
  it("splits on `;` at top level", () => {
    expect(splitScriptStatements("a = 1; b = 2; c = 3")).toEqual(["a = 1", "b = 2", "c = 3"])
  })

  it("splits on newlines", () => {
    expect(splitScriptStatements("for l in rows:\n  print(l)")).toEqual([
      "for l in rows:",
      "print(l)",
    ])
  })

  it("keeps `;` inside quotes", () => {
    expect(splitScriptStatements(`x = "a; b"; y = 'c; d'`)).toEqual([`x = "a; b"`, `y = 'c; d'`])
  })

  it("keeps `;` inside brackets of any flavor", () => {
    expect(splitScriptStatements("f(a; b); g[c; d]; h{e; f}")).toEqual([
      "f(a; b)",
      "g[c; d]",
      "h{e; f}",
    ])
  })

  it("handles nested brackets", () => {
    expect(splitScriptStatements("f(g(a; b); c); d")).toEqual(["f(g(a; b); c)", "d"])
  })

  it("drops empty statements from trailing separators and blank lines", () => {
    expect(splitScriptStatements("a;\n\n;b;")).toEqual(["a", "b"])
  })

  it("keeps a trailing `#` comment on its own statement", () => {
    expect(splitScriptStatements("a = 1  # note\nb = 2")).toEqual(["a = 1  # note", "b = 2"])
  })

  it("does not treat `#` inside a word as a comment", () => {
    expect(splitScriptStatements("x = a#b; y = 2")).toEqual(["x = a#b", "y = 2"])
  })

  it("honours backslash escapes outside quotes", () => {
    expect(splitScriptStatements("echo a\\;b; echo c")).toEqual(["echo a\\;b", "echo c"])
  })

  it("returns [] for a blank payload", () => {
    expect(splitScriptStatements("   \n  ")).toEqual([])
  })
})

describe("detectInlineScript — recognition", () => {
  it("recognises `python -c '…'` and rebuilds the original byte-exactly", () => {
    const cmd = `python -c 'a = 1; b = 2'`
    const got = detectInlineScript(cmd)
    expect(got).not.toBeNull()
    expect(got?.prologue).toBe("python -c '")
    expect(got?.payload).toBe("a = 1; b = 2")
    expect(got?.epilogue).toBe("'")
    expect(got?.statements).toEqual(["a = 1", "b = 2"])
    expect(`${got?.prologue}${got?.payload}${got?.epilogue}`).toBe(cmd)
  })

  it("recognises the reported `uv run … python -c` shape", () => {
    const cmd = `uv run --no-project python -c 'from pathlib import Path; p = Path("/x/AGENTS.md"); s = p.read_text()'`
    const got = detectInlineScript(cmd)
    expect(got?.prologue).toBe("uv run --no-project python -c '")
    expect(got?.statements).toEqual([
      "from pathlib import Path",
      `p = Path("/x/AGENTS.md")`,
      "s = p.read_text()",
    ])
  })

  it("recognises `node -e` and `--eval`", () => {
    expect(detectInlineScript(`node -e 'a(); b()'`)?.statements).toEqual(["a()", "b()"])
    expect(detectInlineScript(`node --eval 'a(); b()'`)?.statements).toEqual(["a()", "b()"])
  })

  it("recognises a bare `jq '…'` program", () => {
    expect(detectInlineScript(`jq '.a; .b'`)?.statements).toEqual([".a", ".b"])
  })

  it("recognises a bare `awk` program with a trailing file argument as epilogue", () => {
    const got = detectInlineScript(`awk 'BEGIN{a()}; {b()}' data.txt`)
    expect(got?.statements).toEqual(["BEGIN{a()}", "{b()}"])
    expect(got?.epilogue).toBe("' data.txt")
  })

  it("returns null for an awk program whose `;` all sit inside one brace block", () => {
    expect(detectInlineScript(`awk '{a(); b()}' data.txt`)).toBeNull()
  })

  it("keeps a shell tail after the closing quote as epilogue", () => {
    const got = detectInlineScript(`python -c 'a = 1; b = 2' && echo done`)
    expect(got?.epilogue).toBe("' && echo done")
  })

  it("handles a double-quoted payload", () => {
    const got = detectInlineScript(`bash -c "echo one; echo two"`)
    expect(got?.quote).toBe('"')
    expect(got?.statements).toEqual(["echo one", "echo two"])
  })

  it("returns null for a plain command", () => {
    expect(detectInlineScript("ls -la")).toBeNull()
  })

  it("returns null for a multi-line command (Zone B owns those)", () => {
    expect(detectInlineScript("python -c 'a = 1\nb = 2'")).toBeNull()
  })

  it("returns null for a quoted argument that is not a script flag payload", () => {
    expect(detectInlineScript(`grep -n "foo; bar" file.md`)).toBeNull()
  })

  it("returns null for a single-statement payload (nothing to gain)", () => {
    expect(detectInlineScript(`python -c 'print(1)'`)).toBeNull()
  })

  it("returns null for a blank payload", () => {
    expect(detectInlineScript(`python -c ''`)).toBeNull()
  })

  it("returns null for an empty command", () => {
    expect(detectInlineScript("")).toBeNull()
  })

  it("ignores `;` inside a subshell in the prologue", () => {
    const cmd = `sh -c 'echo $(printf "a;b"); echo two'`
    const got = detectInlineScript(cmd)
    expect(got?.prologue).toBe("sh -c '")
    expect(got?.statements).toEqual(['echo $(printf "a;b")', "echo two"])
  })
})
