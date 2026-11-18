/**
 * Style-free one-line text of a core `notice` event, for the plain text
 * paths of the CLI (print mode, the plain interactive transcript).
 *
 * The core emits typed {@link TurnNotice} values and owns no text. This
 * file owns the words. The exhaustive `switch` makes a new notice kind a
 * compile error until it has a plain rendering here.
 *
 * @module startup/turn-notice-text
 */

import type { NoticeTarget, TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

/** What the text says for a value of the target that is not set. */
const UNSET: Readonly<Record<string, string>> = {
  credential: "the provider default",
  provider: "none",
  effort: "the model default",
}

/**
 * The values that a target switch changed, as text, in the order of the
 * chain: credential, provider, model, effort. For example
 * `credential to "second" (was "full"), model to "m2" (was "m1")`.
 *
 * `undefined` when the notice has no targets: an automatic model adoption,
 * or a core that does not send them. The caller then names only the model.
 */
export function targetChangeText(notice: {
  readonly fromTarget?: NoticeTarget
  readonly toTarget?: NoticeTarget
}): string | undefined {
  const { fromTarget: from, toTarget: to } = notice
  if (!from || !to) return undefined
  const rows: [string, string | undefined, string | undefined][] = [
    ["credential", from.credentialName, to.credentialName],
    ["provider", from.providerId, to.providerId],
    ["model", from.model, to.model],
    ["effort", from.effort, to.effort],
  ]
  const text = (label: string, value: string | undefined): string =>
    value === undefined ? (UNSET[label] ?? "none") : `"${value}"`
  const changed = rows
    .filter(([, a, b]) => a !== b)
    .map(([label, a, b]) => `${label} to ${text(label, b)} (was ${text(label, a)})`)
  return changed.length > 0 ? changed.join(", ") : undefined
}

/** One plain line for a notice. No ANSI, no trailing newline. */
export function turnNoticePlainText(notice: TurnNotice): string {
  switch (notice.kind) {
    case "refusal":
    case "content_filter": {
      const label = notice.kind === "refusal" ? "refusal" : "content filter"
      const category = notice.category ? ` (${notice.category})` : ""
      const message = notice.message ? ` \u2014 ${notice.message}` : ""
      return `[${label}] The provider's safety layer ended the response${category}${message}. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.`
    }
    case "max_tokens_salvaged":
      return "[max_tokens] Response hit the max_tokens ceiling mid tool-call; salvaged the in-flight call and continuing."
    case "max_tokens_continuing":
      return `[max_tokens] Response hit the max_tokens ceiling; auto-continuing (${notice.attempt}/${notice.cap}).`
    case "max_tokens_capped":
      return `[max_tokens] Response hit the max_tokens ceiling ${notice.cap} times in a row; stopping. Consider narrowing the request or raising max_tokens.`
    case "reflection_ack": {
      const suffix = notice.reason.length > 0 ? ` \u2014 ${notice.reason}` : ""
      const via = notice.fromToolFallback ? " (from tool_use fallback)" : ""
      return `reflection ack: silencing next ${notice.silenceFor} checkpoint${notice.silenceFor === 1 ? "" : "s"}${suffix}${via}`
    }
    case "stream_interrupted_salvaged": {
      const n = notice.completedToolCalls
      return `[stream] Provider closed the response without a terminal event after ${n} complete tool call${n === 1 ? "" : "s"}; salvaged closed tools, discarded partials, and continuing from local state. Do not repeat those tool calls.`
    }
    case "stream_interrupted_continuing":
      return `[stream] Provider closed the response without a terminal event mid-output; auto-continuing from local state (${notice.attempt}/${notice.cap}).`
    case "stream_interrupted_capped":
      return `[stream] Provider closed the response without a terminal event ${notice.cap} times in a row mid-output; stopping. Partial output above is preserved.`
    case "ask_denied":
      return `[ask] No host can answer "${notice.title}" (${notice.code}) in this run; denied the ask and sent the request unchanged.`
    case "model_adopted": {
      // A target switch: name each value that changed (the model can be the same).
      const changed = targetChangeText(notice)
      if (changed) return `[target] Changed ${changed}.`
      const effort = notice.effortReset ? ` (effort reset from "${notice.effortFrom}")` : ""
      return `[model] Adopted model "${notice.to}" (was "${notice.from}")${effort}.`
    }
    case "model_adopt_failed":
      return `[model] Could not adopt model "${notice.requested}" (${notice.reason}); kept "${notice.model}".`
    case "stop_hook_capped":
      return `[stop hook] A turn.willStop hook blocked the stop more than ${notice.cap} times in a row; ended the turn.`
    default: {
      const _exhaustive: never = notice
      return _exhaustive
    }
  }
}
