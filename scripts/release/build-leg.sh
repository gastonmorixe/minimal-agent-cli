#!/usr/bin/env bash
# One build leg of the release: compile, smoke and package every target this
# runner builds. `.github/workflows/release.yml` runs it once per runner, and
# it runs the same on a dev machine.
#
#   scripts/release/build-leg.sh LABEL CHANNEL OUT RAW TARGET...
#
#   LABEL    the release version label: 0.1.0 or 0.1.0-nightly.<stamp>
#   CHANNEL  stable | nightly
#   OUT      packaged assets: <asset>.tar.gz, <id>.target.json, sourcemaps/<id>/
#   RAW      compiled binaries: RAW/<id>/minimal-agent(.map). macOS targets
#            stop here with RAW/<id>/smoke.json: finish-macos.sh signs and
#            packages them, since a tarball must hold the signed binary.
#   TARGET   release target ids (scripts/release/targets.ts)
#
# Smoke per target, recorded as `smoke` in build-info.json:
#   e2e    the host target: compile.ts ran its smoke and compile-e2e.sh
#   basic  smoke-basic.sh ran --version and --help (baseline natively, musl
#          in an Alpine container, darwin-x64 under Rosetta)
#   none   the runner cannot execute it (smoked: false)
#
# A failed non-priority target is a warning on a nightly: the leg goes on and
# the release ships without it. A failed priority target, or any failure on
# the stable channel, fails the leg.
#
# Env: MA_COMPILE_MODE (default release), MA_NO_SMOKE=1 (local test: skip
# every smoke, all targets record `none`), MA_RUNNER (runner label to record).

set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: build-leg.sh LABEL CHANNEL OUT RAW TARGET..." >&2
  exit 2
fi
LABEL="$1"
CHANNEL="$2"
OUT="$3"
RAW="$4"
shift 4

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$CLI_DIR/scripts/release"
MODE="${MA_COMPILE_MODE:-release}"
RUNNER="${MA_RUNNER:-local}"
mkdir -p "$OUT" "$RAW"
OUT="$(cd "$OUT" && pwd)"
RAW="$(cd "$RAW" && pwd)"
cd "$CLI_DIR"

warn() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::warning title=build $1::$2"; else echo "build-leg: warning: $1: $2"; fi
}
error() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::error title=build $1::$2"; else echo "build-leg: error: $1: $2" >&2; fi
}

case "$(uname -s)" in
  Darwin) HOST_OS=darwin ;;
  Linux) HOST_OS=linux ;;
  *) HOST_OS=other ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) HOST_ARCH=x64 ;;
  arm64 | aarch64) HOST_ARCH=arm64 ;;
  *) HOST_ARCH=other ;;
esac
# The version the binary prints (package.json), not the release label.
PKG_VERSION="$(bun -e 'console.log(require("./package.json").version)')"
echo "build-leg: $CHANNEL $LABEL on $RUNNER ($HOST_OS-$HOST_ARCH): $*"

FATAL=0
BUILT=()

# fail_target ID PRIORITY MESSAGE
fail_target() {
  if [[ "$2" == "true" || "$CHANNEL" == "stable" ]]; then
    error "$1" "$3"
    FATAL=1
  else
    warn "$1" "$3 (nightly: shipping without it)"
  fi
  rm -rf "${RAW:?}/$1"
}

for ID in "$@"; do
  row="$(bun run "$HERE/targets.ts" --get "$ID")" || exit 2
  IFS=$'\t' read -r id _bun os arch libc cpu priority <<<"$row"
  bin="$RAW/$id/minimal-agent"
  rm -rf "${RAW:?}/$id"
  mkdir -p "$RAW/$id"

  # compile.ts smokes the host target itself (glibc, not baseline).
  native=false
  if [[ "$os" == "$HOST_OS" && "$arch" == "$HOST_ARCH" && "$libc" != "musl" && "$cpu" == "-" ]]; then
    native=true
  fi
  args=(--mode "$MODE" --target "$id" --outfile "$bin")
  if [[ "${MA_NO_SMOKE:-}" == "1" ]]; then args+=(--no-smoke); fi
  echo "::group::compile $id"
  if ! bun run scripts/compile.ts "${args[@]}"; then
    echo "::endgroup::"
    fail_target "$id" "$priority" "compile (or its smoke/e2e) failed"
    continue
  fi
  echo "::endgroup::"

  smoke=none
  note=""
  smoke_mode=""
  if [[ "${MA_NO_SMOKE:-}" == "1" ]]; then
    note="smoke skipped (MA_NO_SMOKE=1)"
  elif [[ "$native" == "true" ]]; then
    smoke=e2e
  elif [[ "$os" == "$HOST_OS" && "$arch" == "$HOST_ARCH" && "$libc" == "musl" ]]; then
    smoke_mode=alpine
  elif [[ "$os" == "$HOST_OS" && "$arch" == "$HOST_ARCH" ]]; then
    smoke_mode=native
  elif [[ "$os" == darwin && "$HOST_OS" == darwin && "$arch" == x64 && "$HOST_ARCH" == arm64 ]]; then
    smoke_mode=rosetta
  else
    note="cross-compiled on $HOST_OS-$HOST_ARCH, not executed"
  fi
  if [[ -n "$smoke_mode" ]]; then
    set +e
    "$HERE/smoke-basic.sh" "$bin" "$PKG_VERSION" "$smoke_mode"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      smoke=basic
      note="$smoke_mode"
    elif [[ $rc -eq 3 ]]; then
      note="cross-compiled, $smoke_mode unavailable on $RUNNER"
    else
      fail_target "$id" "$priority" "smoke-basic ($smoke_mode) failed"
      continue
    fi
  fi
  echo "build-leg: $id smoke=$smoke${note:+ ($note)}"

  if [[ "$os" == darwin ]]; then
    # finish-macos.sh signs, re-smokes and packages it.
    SMOKE="$smoke" NOTE="$note" RUNNER="$RUNNER" bun -e '
      const { SMOKE, NOTE, RUNNER } = process.env
      await Bun.write(process.argv[1], JSON.stringify({ smoke: SMOKE, note: NOTE || null, runner: RUNNER }) + "\n")
    ' "$RAW/$id/smoke.json"
  else
    pkg_args=(--version "$LABEL" --target "$id" --binary "$bin" --out "$OUT" --smoke "$smoke" --runner "$RUNNER")
    if [[ -n "$note" ]]; then pkg_args+=(--smoke-note "$note"); fi
    if ! bun run "$HERE/package.ts" "${pkg_args[@]}"; then
      fail_target "$id" "$priority" "package failed"
      continue
    fi
    rm -rf "${RAW:?}/$id"
  fi
  BUILT+=("$id")
done

echo "build-leg: built ${BUILT[*]:-nothing}"
exit "$FATAL"
