#!/usr/bin/env bash
# Notarize a Developer ID signed macOS binary with `xcrun notarytool`.
#
#   scripts/release/notarize-macos.sh BINARY
#
# Credentials (an App Store Connect API key, "Developer" role or higher):
#   APPLE_API_KEY_P8_BASE64   the AuthKey_<id>.p8 file, base64
#   APPLE_API_KEY_ID          the key id (10 chars)
#   APPLE_API_ISSUER          the issuer UUID
#
# Missing credentials, not on macOS, or a binary without a Developer ID
# signature: print a warning and exit 0. Notarization is wired, not
# required: the owner has no Developer ID yet.
#
# A bare Mach-O cannot be stapled, so the ticket lives on Apple's servers
# and Gatekeeper checks it online on first launch. The binary is submitted
# inside a zip (notarytool takes zip, pkg or dmg) and the zip is discarded.
#
# Prints `true` or `false` on stdout (notarized or not). With GITHUB_OUTPUT
# set, also writes `notarized=<value>` there. A configured notarization
# that Apple rejects exits 1 (the log is printed). MA_SIGNING_SOFT_FAIL=1
# turns that into a warning.

set -euo pipefail

warn() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning title=macOS notarization::$*" >&2
  else
    echo "notarize-macos: warning: $*" >&2
  fi
}
log() { echo "notarize-macos: $*" >&2; }
# `base64 --decode` needs macOS 13+, older macOS spells it `-D`.
b64decode() {
  local in
  in="$(cat)"
  printf '%s' "$in" | base64 --decode 2>/dev/null || printf '%s' "$in" | base64 -D
}

result() {
  echo "$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "notarized=$1" >>"$GITHUB_OUTPUT"; fi
}

soft_fail() {
  if [[ "${MA_SIGNING_SOFT_FAIL:-}" == "1" ]]; then
    warn "$* (MA_SIGNING_SOFT_FAIL=1: continuing unnotarized)"
    result false
    exit 0
  fi
  echo "notarize-macos: error: $*" >&2
  exit 1
}

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "usage: notarize-macos.sh BINARY (no file at '${BIN}')" >&2
  exit 2
fi

KEY_B64="${APPLE_API_KEY_P8_BASE64:-}"
KEY_ID="${APPLE_API_KEY_ID:-}"
ISSUER="${APPLE_API_ISSUER:-}"
if [[ -z "$KEY_B64" || -z "$KEY_ID" || -z "$ISSUER" ]]; then
  warn "no notarization credentials (APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID, APPLE_API_ISSUER): $(basename "$BIN") is not notarized"
  result false
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "not on macOS: $(basename "$BIN") is not notarized (notarytool needs a Mac)"
  result false
  exit 0
fi

if ! codesign --display --verbose=2 "$BIN" 2>&1 | grep -q '^Authority=Developer ID Application'; then
  warn "$(basename "$BIN") has no Developer ID signature (signing skipped?): not notarizing"
  result false
  exit 0
fi

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ma-notarize-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
KEY="$WORK/AuthKey_${KEY_ID}.p8"
printf '%s' "$KEY_B64" | b64decode >"$KEY" || soft_fail "APPLE_API_KEY_P8_BASE64 is not valid base64"
chmod 600 "$KEY"
ZIP="$WORK/$(basename "$BIN").zip"
ditto -c -k --keepParent "$BIN" "$ZIP"

log "submitting $(basename "$BIN") to the notary service (waits up to 30m)"
set +e
OUT="$(xcrun notarytool submit "$ZIP" --key "$KEY" --key-id "$KEY_ID" --issuer "$ISSUER" \
  --wait --timeout 30m --output-format json 2>&1)"
CODE=$?
set -e
echo "$OUT" >&2
STATUS="$(printf '%s' "$OUT" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' | tail -n 1)"
ID="$(printf '%s' "$OUT" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n 1)"
if [[ "$CODE" -ne 0 || "$STATUS" != "Accepted" ]]; then
  if [[ -n "$ID" ]]; then
    xcrun notarytool log "$ID" --key "$KEY" --key-id "$KEY_ID" --issuer "$ISSUER" >&2 || true
  fi
  soft_fail "notarization of $(basename "$BIN") ended with status '${STATUS:-unknown}' (exit $CODE)"
fi
log "accepted (submission $ID)"
result true
