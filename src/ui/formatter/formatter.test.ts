import { describe, expect, it } from "bun:test"

import { Formatter } from "./formatter.ts"

class FakeOutput {
  readonly chunks: string[] = []
  columns?: number
  rows?: number

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  text(): string {
    return this.chunks.join("")
  }
}

describe("Formatter", () => {
  it("strips a leading formatter newline from the first stdout chunk", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(["sh", "-c", "printf '\\nHELLO'"], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("HELLO")
  })

  it("preserves formatter output when the first chunk does not start with a newline", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(["sh", "-c", "printf HELLO"], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("HELLO")
  })

  it("passes output dimensions to formatter subprocesses", async () => {
    const output = new FakeOutput()
    output.columns = 60
    output.rows = 17
    const formatter = new Formatter(["sh", "-c", 'printf "%s:%s" "$COLUMNS" "$LINES"'], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("60:17")
  })

  it("routes formatter stderr through the configured output sink", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(["sh", "-c", "printf 'formatter warning' >&2"], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("formatter warning")
  })

  it("keeps split ANSI sequences intact across formatter stdout chunks", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(
      ["sh", "-c", "printf '\\033[31'; sleep 0.01; printf 'mred\\033[0m'"],
      output,
    )

    formatter.start()
    await formatter.end()

    expect(output.chunks).not.toContain("\x1b[31")
    expect(output.text()).toBe("\x1b[31mred\x1b[0m")
  })
})
