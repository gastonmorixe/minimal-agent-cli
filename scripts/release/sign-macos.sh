#!/usr/bin/env bash
# Sign a macOS minimal-agent binary with a Developer ID, hardened runtime,
# and the JIT entitlements in entitlements.plist.
#
#   scripts/release/sign-macos.sh BINARY
#
# Credentials, picked in this order:
#   1. CI: MACOS_CERT_P12_BASE64 + MACOS_CERT_PASSWORD (+ MACOS_SIGN_IDENTITY,
#      else the first "Developer ID Application" identity in the .p12). The
#      cert goes into a throwaway keychain that is deleted on exit.
#   2. A dev Mac: MACOS_SIGN_IDENTITY alone, an identity already in the
#      login keychain (`security find-identity -v -p codesigning`).
#
# Missing credentials, or not on macOS: print a warning and exit 0 with the
# binary unchanged (Bun's ad-hoc signature stays, which arm64 needs to run).
# Signing is wired, not required: the owner has no Developer ID yet.
#
# Prints one line on stdout, the result: `developer-id` or `adhoc`. Logs go
# to stderr. With GITHUB_OUTPUT set, also writes `signed=<result>` there.
# A configured signing that then fails exits 1: a broken cert must be loud.
# MA_SIGNING_SOFT_FAIL=1 turns that into a warning too.

set -euo pipefail

warn() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning title=macOS signing::$*" >&2
  else
    echo "sign-macos: warning: $*" >&2
  fi
}
log() { echo "sign-macos: $*" >&2; }
# `base64 --decode` needs macOS 13+, older macOS spells it `-D`.
b64decode() {
  local in
  in="$(cat)"
  printf '%s' "$in" | base64 --decode 2>/dev/null || printf '%s' "$in" | base64 -D
}

result() {
  echo "$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "signed=$1" >>"$GITHUB_OUTPUT"; fi
}

soft_fail() {
  if [[ "${MA_SIGNING_SOFT_FAIL:-}" == "1" ]]; then
    warn "$* (MA_SIGNING_SOFT_FAIL=1: continuing unsigned)"
    result adhoc
    exit 0
  fi
  echo "sign-macos: error: $*" >&2
  exit 1
}

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "usage: sign-macos.sh BINARY (no file at '${BIN}')" >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$HERE/entitlements.plist"

P12="${MACOS_CERT_P12_BASE64:-}"
P12_PASS="${MACOS_CERT_PASSWORD:-}"
IDENTITY="${MACOS_SIGN_IDENTITY:-}"
KEYCHAIN=""

if [[ -z "$P12" && -z "$IDENTITY" ]]; then
  warn "no signing credentials (MACOS_CERT_P12_BASE64 + MACOS_CERT_PASSWORD, or MACOS_SIGN_IDENTITY): $(basename "$BIN") ships ad-hoc signed and unnotarized"
  result adhoc
  exit 0
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "not on macOS: $BIN keeps its ad-hoc signature (codesign needs a Mac)"
  result adhoc
  exit 0
fi

cleanup() {
  if [[ -n "$KEYCHAIN" ]]; then
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
    rm -f "${KEYCHAIN_P12:-}"
  fi
}
trap cleanup EXIT

if [[ -n "$P12" ]]; then
  if [[ -z "$P12_PASS" ]]; then
    soft_fail "MACOS_CERT_P12_BASE64 is set but MACOS_CERT_PASSWORD is empty"
  fi
  TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  KEYCHAIN="$TMP/ma-signing-$$.keychain-db"
  KEYCHAIN_P12="$TMP/ma-signing-$$.p12"
  KC_PASS="$(openssl rand -hex 24)"
  printf '%s' "$P12" | b64decode >"$KEYCHAIN_P12" || soft_fail "MACOS_CERT_P12_BASE64 is not valid base64"
  security create-keychain -p "$KC_PASS" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KC_PASS" "$KEYCHAIN"
  security import "$KEYCHAIN_P12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign -f pkcs12 >/dev/null \
    || soft_fail "security import of the .p12 failed (wrong MACOS_CERT_PASSWORD?)"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KEYCHAIN" >/dev/null
  # codesign searches the user keychain list: put ours first, keep the rest.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" |
      sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)"
    [[ -n "$IDENTITY" ]] || soft_fail "the .p12 holds no 'Developer ID Application' identity"
  fi
  KEYCHAIN_ARGS=(--keychain "$KEYCHAIN")
else
  if ! security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
    soft_fail "MACOS_SIGN_IDENTITY '$IDENTITY' is not a valid codesigning identity in your keychains"
  fi
  KEYCHAIN_ARGS=()
fi

log "signing $BIN as '$IDENTITY'"
# --options runtime: hardened runtime, required for notarization.
# --timestamp: a secure timestamp, also required for notarization.
# The `${a[@]+...}` form keeps an empty array legal under `set -u` in the
# bash 3.2 that macOS ships as /bin/bash.
codesign --force --sign "$IDENTITY" ${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"} \
  --options runtime --timestamp --entitlements "$ENTITLEMENTS" "$BIN" >&2 \
  || soft_fail "codesign failed for $BIN"
codesign --verify --strict --verbose=2 "$BIN" >&2 || soft_fail "codesign --verify failed for $BIN"
codesign --display --verbose=2 "$BIN" 2>&1 | grep -E '^(Authority|TeamIdentifier|Runtime)' >&2 || true
result developer-id
