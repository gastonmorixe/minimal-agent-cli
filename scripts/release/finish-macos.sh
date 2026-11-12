#!/usr/bin/env bash
# Sign, notarize, re-smoke and package the macOS binaries a build leg left
# in RAW (RAW/<id>/minimal-agent + smoke.json, see build-leg.sh).
#
#   scripts/release/finish-macos.sh LABEL RAW OUT
#
# Signing and notarization are gated by their secrets (see sign-macos.sh and
# notarize-macos.sh): without them, or off macOS, each step warns and the
# binary keeps Bun's ad-hoc signature. A Developer ID signed binary runs
# with the hardened runtime, so on a Mac it is smoked again: a missing JIT
# entitlement must fail here, not on a user's machine.
#
# An empty RAW (no macOS leg finished) is not an error: assemble.ts decides
# whether the release can ship without the macOS targets.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: finish-macos.sh LABEL RAW OUT" >&2
  exit 2
fi
LABEL="$1"
RAW="$2"
OUT="$3"
CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$CLI_DIR/scripts/release"
mkdir -p "$OUT"
cd "$CLI_DIR"
PKG_VERSION="$(bun -e 'console.log(require("./package.json").version)')"
HOST_ARCH="$(uname -m)"

shopt -s nullglob
found=0
for dir in "$RAW"/*/; do
  dir="${dir%/}"
  id="$(basename "$dir")"
  bin="$dir/minimal-agent"
  [[ -f "$bin" && -f "$dir/smoke.json" ]] || continue
  found=1
  # One field per line, so a note with spaces survives `read`.
  {
    read -r smoke
    read -r note
    read -r runner
  } < <(bun -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log([j.smoke ?? "none", j.note ?? "", j.runner ?? "-"].join("\n"))
  ' "$dir/smoke.json")

  # Keep each script's GITHUB_OUTPUT line out of this job's outputs.
  signed="$(GITHUB_OUTPUT="" "$HERE/sign-macos.sh" "$bin")"
  notarized=false
  if [[ "$signed" == "developer-id" ]]; then
    notarized="$(GITHUB_OUTPUT="" "$HERE/notarize-macos.sh" "$bin")"
    if [[ "$(uname -s)" == "Darwin" ]]; then
      mode=""
      if [[ "$id" == darwin-arm64 && "$HOST_ARCH" == arm64 ]]; then mode=native; fi
      if [[ "$id" == darwin-x64 && "$HOST_ARCH" == x86_64 ]]; then mode=native; fi
      if [[ "$id" == darwin-x64 && "$HOST_ARCH" == arm64 ]]; then mode=rosetta; fi
      if [[ -n "$mode" ]]; then
        set +e
        "$HERE/smoke-basic.sh" "$bin" "$PKG_VERSION" "$mode"
        rc=$?
        set -e
        if [[ $rc -ne 0 && $rc -ne 3 ]]; then
          echo "finish-macos: the signed $id binary does not run (hardened runtime): check entitlements.plist" >&2
          exit 1
        fi
        if [[ $rc -eq 0 && "$smoke" == none ]]; then
          smoke=basic
          note="signed binary, $mode"
        fi
      fi
    fi
  fi

  args=(--version "$LABEL" --target "$id" --binary "$bin" --out "$OUT" --smoke "$smoke"
    --signed "$signed" --runner "$runner")
  if [[ -n "$note" ]]; then args+=(--smoke-note "$note"); fi
  if [[ "$notarized" == "true" ]]; then args+=(--notarized); fi
  bun run "$HERE/package.ts" "${args[@]}"
done

if [[ $found -eq 0 ]]; then
  echo "finish-macos: no macOS binaries in $RAW (did the macOS leg fail?)" >&2
fi
