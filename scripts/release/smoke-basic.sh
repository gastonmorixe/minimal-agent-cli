#!/usr/bin/env bash
# Basic smoke of a built binary that compile.ts could not smoke itself:
# a cross target the runner can still execute, or a binary re-signed after
# compile (hardened runtime). Runs `--version` and `--help` from an empty dir
# with a fresh HOME and a minimal env.
#
#   scripts/release/smoke-basic.sh BINARY VERSION [native|rosetta|alpine]
#
#   native   run it directly (default)
#   rosetta  `arch -x86_64` (darwin-x64 on an Apple silicon Mac)
#   alpine   inside `docker run alpine` (a musl target on a glibc runner),
#            with the libstdc++ and libgcc a Bun musl binary links
#
# Exit 0 when both commands exit 0 and `--version` names VERSION. Exit 1 on a
# failed check, 3 when the runner cannot run this mode at all (no Rosetta, no
# docker), so the caller can record "not smoked" instead of "broken".

set -euo pipefail

BIN="${1:-}"
WANT="${2:-}"
MODE="${3:-native}"
if [[ -z "$BIN" || ! -f "$BIN" || -z "$WANT" ]]; then
  echo "usage: smoke-basic.sh BINARY VERSION [native|rosetta|alpine]" >&2
  exit 2
fi
chmod +x "$BIN"
BIN="$(cd "$(dirname "$BIN")" && pwd -P)/$(basename "$BIN")"

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ma-smoke-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/cwd"

case "$MODE" in
  native) PREFIX=() ;;
  rosetta)
    if ! arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
      echo "smoke-basic: Rosetta 2 is not available on this runner" >&2
      exit 3
    fi
    PREFIX=(arch -x86_64)
    ;;
  alpine)
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      echo "smoke-basic: docker is not available on this runner" >&2
      exit 3
    fi
    docker pull -q alpine:3 >/dev/null
    ;;
  *)
    echo "smoke-basic: unknown mode $MODE" >&2
    exit 2
    ;;
esac

# Prints the combined output of one run. Fails on a non-zero exit.
run_one() {
  if [[ "$MODE" == "alpine" ]]; then
    docker run --rm -v "$BIN:/usr/local/bin/minimal-agent:ro" alpine:3 sh -c \
      "apk add --no-cache -q libstdc++ libgcc >/dev/null && cd /tmp && HOME=/tmp MINIMAL_AGENT_NO_PLUGIN_SYNC=1 MINIMAL_AGENT_NO_BINARY_SETUP=1 TERM=dumb NO_COLOR=1 minimal-agent $*" 2>&1
  else
    (cd "$WORK/cwd" && env -i "PATH=/usr/bin:/bin" "HOME=$WORK/home" \
      "MINIMAL_AGENT_HOME=$WORK/home/.minimal-agent" MINIMAL_AGENT_NO_PLUGIN_SYNC=1 \
      MINIMAL_AGENT_NO_BINARY_SETUP=1 TERM=dumb NO_COLOR=1 \
      ${PREFIX[@]+"${PREFIX[@]}"} "$BIN" "$@" 2>&1)
  fi
}

if ! out="$(run_one --version)"; then
  printf '%s\n' "$out" | tail -n 20 >&2
  echo "smoke-basic: --version failed ($MODE)" >&2
  exit 1
fi
if [[ "$out" != *"$WANT"* ]]; then
  printf '%s\n' "$out" >&2
  echo "smoke-basic: --version does not name $WANT ($MODE)" >&2
  exit 1
fi
echo "smoke-basic: ok --version: $(printf '%s\n' "$out" | grep -F "$WANT" | head -n 1)"
if ! out="$(run_one --help)"; then
  printf '%s\n' "$out" | tail -n 20 >&2
  echo "smoke-basic: --help failed ($MODE)" >&2
  exit 1
fi
echo "smoke-basic: ok --help ($MODE)"
