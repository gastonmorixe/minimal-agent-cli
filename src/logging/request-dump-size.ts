/**
 * Approximate sizes of the request dump parts: the UTF-8 bytes of the text
 * that goes on the wire for a part, and the approximate token count of that
 * text. The token count uses the estimator that the provider plugin set for
 * the (provider, model) pair. The view looks it up ONE time
 * ({@link dumpEstimator}) and gives it to each {@link sizeOf} call. When the
 * pair has no estimator, the sizes have bytes only: the host never invents a
 * ratio.
 *
 * @module logging/request-dump-size
 */

import { lookupTokenEstimator, type TokenEstimator } from "@minimal-agent/core/host/token-estimate"
import { formatBytes, formatTokenCount } from "../ui/format/numbers.ts"

/** The size of one dump part. */
export interface DumpSize {
  /** UTF-8 bytes of the wire text. */
  readonly bytes: number
  /** Approximate tokens of the wire text. Absent when the model has no estimator. */
  readonly tokens?: number
}

const encoder = new TextEncoder()

/**
 * The token estimator of a request, or `undefined`. Call it one time for each
 * view, not for each part.
 *
 * @param model - The model id of the request.
 * @param providerId - The provider id of the request (`RequestSnapshot.providerId`).
 */
export function dumpEstimator(
  model: string | undefined,
  providerId: string | undefined,
): TokenEstimator | undefined {
  return lookupTokenEstimator(model, providerId)
}

/** The size of `text`. With no `estimate`, the size has bytes only. */
export function sizeOf(estimate: TokenEstimator | undefined, text: string): DumpSize {
  const bytes = encoder.encode(text).length
  return estimate === undefined ? { bytes } : { bytes, tokens: estimate(text) }
}

/** The zero size: with a token count of 0 when the view has an estimator. */
export function zeroSize(estimate: TokenEstimator | undefined): DumpSize {
  return estimate === undefined ? { bytes: 0 } : { bytes: 0, tokens: 0 }
}

/**
 * The sum of sizes. The sum has a token count when one size or more has one
 * (one view uses one estimator, thus all its sizes have tokens or none have).
 */
export function sumSizes(sizes: readonly DumpSize[]): DumpSize {
  let bytes = 0
  let tokens = 0
  let counted = false
  for (const s of sizes) {
    bytes += s.bytes
    if (s.tokens !== undefined) {
      tokens += s.tokens
      counted = true
    }
  }
  return counted ? { bytes, tokens } : { bytes }
}

/** The size label, for example `1.2 kB · ~310 tok`, or `1.2 kB` with no token count. */
export function sizeLabel(size: DumpSize): string {
  const bytes = formatBytes(size.bytes)
  return size.tokens === undefined ? bytes : `${bytes} · ~${formatTokenCount(size.tokens)} tok`
}
