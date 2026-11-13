import { describe, expect, it } from "bun:test"

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { renderCommandList } from "./command-list.ts"
import { renderCommandTable, writeCommandTable } from "./command-table.ts"

describe("renderCommandList", () => {
  it("renders titled framed items with summary", () => {
    const rows = renderCommandList({
      title: "Things",
      subtitle: "Pick one",
      items: [
        { title: "alpha", footer: "first" },
        { title: "beta", body: ["description", "source: test"], footer: "when: always" },
      ],
      summary: "2 things total",
    }).map(stripAnsi)

    expect(rows).toEqual([
      "",
      "  Things",
      "  Pick one",
      "",
      "  ╭ alpha",
      "  ╰ first",
      "",
      "  ╭ beta",
      "  │ description",
      "  │ source: test",
      "  ╰ when: always",
      "",
      "  2 things total",
    ])
  })
})

describe("renderCommandTable", () => {
  it("renders aligned sections with summary", () => {
    const rows = renderCommandTable({
      columns: [
        { key: "id", minWidth: 5, color: "cyan" },
        { key: "name", minWidth: 4, color: "dim" },
      ],
      sections: [
        {
          title: "provider",
          rows: [{ cells: { id: "a", name: "one" } }, { cells: { id: "longer", name: "two" } }],
        },
      ],
      summary: "2 rows",
    }).map(stripAnsi)

    expect(rows).toEqual(["", "  provider", "    a      one", "    longer two", "  2 rows"])
  })

  it("emits no SGR when color is off", () => {
    const rows = renderCommandTable({
      columns: [
        { key: "id", minWidth: 5, color: "cyan" },
        { key: "name", minWidth: 4, color: "dim" },
      ],
      sections: [
        {
          title: "provider",
          rows: [{ cells: { id: "a", name: "one" } }],
        },
      ],
      summary: "1 row",
      color: false,
    })

    for (const row of rows) expect(row).not.toContain("\x1b[")
    expect(rows).toEqual(["", "  provider", "    a     one", "  1 row"])
  })
})

describe("writeCommandTable color policy", () => {
  /** A sink that records writes and reports a fixed TTY state. */
  function sink(isTTY: boolean | undefined): {
    stream: { write(s: string): void; isTTY?: boolean }
    read(): string
  } {
    let out = ""
    const write = (s: string): void => void (out += s)
    const stream = isTTY === undefined ? { write } : { write, isTTY }
    return { stream, read: () => out }
  }

  const spec = {
    columns: [{ key: "id", minWidth: 5, color: "cyan" as const }],
    sections: [{ rows: [{ cells: { id: "alpha" } }] }],
    summary: "1 row",
  }

  /** Run `fn` with a patched env, restoring every touched key. */
  function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
    const saved = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(patch)) {
      saved.set(k, process.env[k])
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      fn()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it("paints on a TTY with no NO_COLOR and a real TERM", () => {
    withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
      const s = sink(true)
      writeCommandTable(spec, s.stream)
      expect(s.read()).toContain("\x1b[")
    })
  })

  it("emits no SGR when piped", () => {
    withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
      const s = sink(undefined)
      writeCommandTable(spec, s.stream)
      expect(s.read()).not.toContain("\x1b[")
    })
  })

  it("emits no SGR under NO_COLOR=1 on a TTY", () => {
    withEnv({ NO_COLOR: "1", TERM: "xterm-256color" }, () => {
      const s = sink(true)
      writeCommandTable(spec, s.stream)
      expect(s.read()).not.toContain("\x1b[")
    })
  })

  it("emits no SGR under TERM=dumb on a TTY", () => {
    withEnv({ NO_COLOR: undefined, TERM: "dumb" }, () => {
      const s = sink(true)
      writeCommandTable(spec, s.stream)
      expect(s.read()).not.toContain("\x1b[")
    })
  })
})
