/** Synthetic session fixtures for the dump parity test. Synthetic data only. */

export const T = "2026-01-01T00:00:00.000Z"
export const meta = (sid: string) => ({
  kind: "meta",
  formatVersion: 1,
  sid,
  createdAt: T,
  model: "model-x",
  cwd: "/proj/demo",
  systemHash: "s",
  toolsHash: "t",
  agentVersion: "0.0.0",
})
const LONG = `${"alpha beta  gamma\n".repeat(80)}NEEDLE-ONE ${"delta ".repeat(120)}`
const B64 = "A".repeat(400)

export const fixtures: Record<string, unknown[]> = {
  "fx-one": [
    meta("fx-one"),
    {
      kind: "user",
      ts: T,
      id: "u1",
      content: `  first   prompt\nwith   spaces ${"w".repeat(200)} `,
    },
    {
      kind: "assistant",
      ts: T,
      stopReason: "tool_use",
      content: [
        {
          type: "thinking",
          thinking: 'think <a> & "b"\nline2',
          signature: "sig-abcdefghijklmnopqrstu",
        },
        { type: "thinking", thinking: "", signature: "sig-redacted-abcdefghijklmnop" },
        { type: "redacted_thinking", data: "ENC123456" },
        { type: "text", text: "I will run it" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { cmd: "echo 'hi' > \"x\"", n: [1, 2] },
        },
      ],
    },
    {
      kind: "tool_result",
      ts: T,
      tool_use_id: "tu-1",
      isError: true,
      content: "boom <err>\nline2",
    },
    {
      kind: "user",
      ts: T,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          is_error: true,
          content: `boom <err>\nline2 data:image/png;base64,${B64} z`,
        },
        { type: "text", text: "next" },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "", content: [] },
  ],
  "fx-two": [
    meta("fx-two"),
    {
      kind: "user",
      ts: T,
      id: "u1",
      content: [
        { type: "text", text: "Question one" },
        { type: "text", text: "more" },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: LONG }] },
    { kind: "note", ts: T, text: "a note NEEDLE-ONE inside" },
    {
      kind: "compact",
      ts: T,
      reason: "manual",
      compactKind: "local",
      messagesBefore: 9,
      messagesAfter: 2,
      replacementMessages: [
        { role: "user", content: "summary of the past NEEDLE-ONE" },
        { role: "assistant", content: "ack" },
      ],
    },
    { kind: "user", ts: T, id: "u2", content: "after compact" },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
  ],
  "fx-three": [
    meta("fx-three"),
    { kind: "user", ts: T, id: "u1", content: "one" },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "two" }] },
    { kind: "rewind", ts: T, to: "u1", droppedCount: 2 },
    { kind: "user", ts: T, id: "u3", content: "redo" },
    {
      kind: "assistant",
      ts: T,
      stopReason: "tool_use",
      content: [
        { type: "tool_use", id: "tu-9", name: "Read", input: { path: "a/b.txt" } },
        { type: "tool_use", id: "tu-10", name: "Bash", input: { cmd: "ls" } },
      ],
    },
    {
      kind: "tool_result",
      ts: T,
      tool_use_id: "tu-9",
      isError: false,
      content: `data:image/png;base64,${B64} tail`,
    },
    {
      kind: "user",
      ts: T,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-9",
          content: [
            { type: "text", text: `x data:image/png;base64,${B64} y` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "zz" } },
          ],
        },
        { type: "tool_result", tool_use_id: "tu-10", content: "" },
        { type: "document", source: { type: "url", url: "https://example.test/d.pdf" } },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "end" }] },
  ],
}
