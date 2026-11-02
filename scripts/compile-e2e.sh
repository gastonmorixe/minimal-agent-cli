#!/usr/bin/env bash
# End-to-end checks for a compiled minimal-agent binary, run the way a user
# runs it. `scripts/compile.ts` runs this on every native build before it
# replaces the output file. It also runs by hand on any binary:
#
#   scripts/compile-e2e.sh [BINARY]        # default: dist/minimal-agent
#
# Setup: the binary is copied to a fresh dir in the OS temp dir, outside this
# repo, and runs with a fresh HOME, a minimal env, and a cwd with no
# node_modules above it (a node_modules would let a broken binary resolve
# core from disk and pass).
#
# Checks:
#   1. `--help` exits 0, prints the command map, and shows the version in
#      package.json (a binary that reads package.json from disk shows 0.0.0).
#   2. `plugins` exits 0, and the fixture provider plugin in HOME loads from
#      disk: it imports core by package name with `import` and `require()`,
#      checks that both give the same class, and writes a marker file.
#   3. The cwd holds a hostile `bunfig.toml` (a `preload` script) and a
#      `.env`. The binary must not run the preload or load the `.env`.
#   4. `-p` with no credentials exits non-zero at the credentials check.
#   5. The interactive REPL in tmux starts and stops at the credentials
#      check (the fresh HOME has none). Skipped without tmux.
#
# Every output is also scanned for crash text (CRASH_RE). Each command has a
# time limit. Exit codes: 0 all checks passed, 1 a check failed, 2 bad usage
# or environment.

set -u -o pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_BIN="${1:-$CLI_DIR/dist/minimal-agent}"
if [[ ! -f "$SRC_BIN" || ! -x "$SRC_BIN" ]]; then
  echo "e2e: no executable file at $SRC_BIN" >&2
  exit 2
fi

TIMEOUT_SECS=30
CRASH_RE='Cannot find package|ENOENT|at .*\(/\$bunfs/|^error: |panic'
SESSION="ma-e2e-$$-$RANDOM"
CHILD=""
WATCHER=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimal-agent-e2e-XXXXXX")" || exit 2
WORK="$(cd "$WORK" && pwd -P)"

cleanup() {
  [[ -n "$CHILD" ]] && kill -KILL "$CHILD" 2>/dev/null
  [[ -n "$WATCHER" ]] && kill "$WATCHER" 2>/dev/null
  if command -v tmux >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

d="$WORK"
while [[ "$d" != "/" ]]; do
  if [[ -e "$d/node_modules" ]]; then
    echo "e2e: $d/node_modules would mask a resolution bug; set TMPDIR to a clean dir" >&2
    exit 2
  fi
  d="$(dirname "$d")"
done

BIN="$WORK/bin/minimal-agent"
HOME_DIR="$WORK/home"
PROJECT="$WORK/project"
PLUGIN_DIR="$HOME_DIR/.minimal-agent/plugins/llm-e2e-fixture"
MARKER="$WORK/plugin-loaded"
PRELOAD_MARKER="$WORK/preload-ran"
mkdir -p "$WORK/bin" "$PLUGIN_DIR" "$PROJECT" || exit 2
cp "$SRC_BIN" "$BIN" || exit 2

# Fixture provider plugin. Provider discovery imports it from disk. It
# exports no valid provider, so discovery then skips it.
cat >"$PLUGIN_DIR/provider.json" <<'EOF'
{ "id": "e2e-fixture", "entry": "./index.ts", "export": "fixture" }
EOF
cat >"$PLUGIN_DIR/index.ts" <<'EOF'
import { writeFileSync } from "node:fs"
import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
const viaRequire = require("@minimal-agent/core/plugin-api/llm/errors")
const sameClass = viaRequire.ProviderError === ProviderError
const err = new viaRequire.ProviderError("x", "e2e-fixture")
const record = {
  sameClass,
  instanceOf: err instanceof ProviderError,
  dotenv: process.env.MA_E2E_DOTENV ?? null,
}
writeFileSync(process.env.MA_E2E_MARKER ?? "/dev/null", JSON.stringify(record))
export const fixture = {}
EOF

# Hostile project dir: Bun reads these from the cwd unless the build turns
# the autoload off.
cat >"$PROJECT/bunfig.toml" <<'EOF'
preload = ["./preload.ts"]
EOF
cat >"$PROJECT/preload.ts" <<'EOF'
require("node:fs").writeFileSync(process.env.MA_E2E_PRELOAD_MARKER ?? "/dev/null", "ran")
EOF
echo "MA_E2E_DOTENV=leaked" >"$PROJECT/.env"

if [[ "$(uname -s)" == "Darwin" ]]; then UTF8_LANG="en_US.UTF-8"; else UTF8_LANG="C.UTF-8"; fi
ENV=(env -i "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "HOME=$HOME_DIR" "LANG=$UTF8_LANG"
  "MINIMAL_AGENT_NO_PLUGIN_SYNC=1" "MINIMAL_AGENT_NO_BINARY_SETUP=1"
  "MA_E2E_MARKER=$MARKER" "MA_E2E_PRELOAD_MARKER=$PRELOAD_MARKER")

failures=0
pass() { echo "e2e: ok    $1"; }
failed() {
  echo "e2e: FAIL  $1" >&2
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" | tail -n 15 | sed 's/^/      /' >&2; fi
  failures=$((failures + 1))
}

# run NAME ARGS...: run the binary in the project dir with a time limit.
# Sets OUT (stdout + stderr) and CODE (124 on timeout).
run() {
  local name="$1"
  shift
  local out_file="$WORK/out-$failures-$RANDOM"
  rm -f "$WORK/timed-out"
  (cd "$PROJECT" && exec "${ENV[@]}" TERM=dumb NO_COLOR=1 "$BIN" "$@") \
    </dev/null >"$out_file" 2>&1 &
  CHILD=$!
  (
    sleep "$TIMEOUT_SECS"
    touch "$WORK/timed-out"
    kill -TERM "$CHILD" 2>/dev/null
    sleep 2
    kill -KILL "$CHILD" 2>/dev/null
  ) &
  WATCHER=$!
  wait "$CHILD"
  CODE=$?
  kill "$WATCHER" 2>/dev/null
  wait "$WATCHER" 2>/dev/null
  CHILD=""
  WATCHER=""
  OUT="$(cat "$out_file")"
  if [[ -e "$WORK/timed-out" ]]; then
    CODE=124
    failed "$name: no exit after ${TIMEOUT_SECS}s" "$OUT"
    return 1
  fi
  if grep -qE "$CRASH_RE" <<<"$OUT"; then
    failed "$name: crash output (exit $CODE)" "$OUT"
    return 1
  fi
  return 0
}

# 1. --help, and the version it prints matches the CLI package.json (a
# binary has no package.json on disk; a file read there falls back to 0.0.0).
WANT_VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$CLI_DIR/package.json" | head -n 1)"
if run "--help" --help; then
  if [[ "$CODE" != "0" ]]; then
    failed "--help: exit $CODE" "$OUT"
  elif ! grep -q "Command map" <<<"$OUT"; then
    failed "--help: no command map in the output" "$OUT"
  else
    pass "--help"
  fi
  if [[ -n "$WANT_VERSION" ]] && ! grep -q "v$WANT_VERSION" <<<"$OUT"; then
    failed "--help: version is not v$WANT_VERSION (package.json)" "$(head -n 3 <<<"$OUT")"
  else
    pass "--help shows v$WANT_VERSION"
  fi
fi

# 2 + 3. plugins: the fixture plugin loads; the hostile cwd files are ignored.
rm -f "$MARKER" "$PRELOAD_MARKER"
if run "plugins" plugins; then
  if [[ "$CODE" != "0" ]]; then
    failed "plugins: exit $CODE" "$OUT"
  elif [[ ! -s "$MARKER" ]]; then
    failed "plugins: the fixture plugin on disk did not load" "$OUT"
  else
    record="$(cat "$MARKER")"
    if grep -q '"sameClass":true' <<<"$record" && grep -q '"instanceOf":true' <<<"$record"; then
      pass "plugins: a disk plugin gets the binary's core (import and require)"
    else
      failed "plugins: the disk plugin got a different core instance" "$record"
    fi
    if grep -q '"dotenv":null' <<<"$record"; then
      pass "cwd .env is not loaded"
    else
      failed "cwd .env was loaded into the process env" "$record"
    fi
  fi
fi
if [[ -e "$PRELOAD_MARKER" ]]; then
  failed "cwd bunfig.toml preload ran (arbitrary code from the cwd)"
else
  pass "cwd bunfig.toml preload did not run"
fi

# 4. -p with no credentials.
if run "-p" --skip-quota -p "hi"; then
  if [[ "$CODE" == "0" ]]; then
    failed "-p: exit 0 with no credentials" "$OUT"
  elif grep -qE 'no provider credentials|no credentials for provider' <<<"$OUT"; then
    pass "-p stops at the credentials check"
  else
    failed "-p: exit $CODE, not at the credentials check" "$OUT"
  fi
fi

# 5. Interactive REPL in tmux.
if command -v tmux >/dev/null 2>&1; then
  {
    echo '#!/usr/bin/env bash'
    printf 'cd %q || exit 1\n' "$PROJECT"
    printf '%q ' "${ENV[@]}" "TERM=xterm-256color" "$BIN" --skip-quota
    echo
    echo 'echo "__EXIT_CODE=$?"'
    echo 'sleep 30'
  } >"$WORK/repl.sh"
  chmod +x "$WORK/repl.sh"
  if ! tmux new-session -d -s "$SESSION" -x 120 -y 40 "$(printf '%q' "$WORK/repl.sh")"; then
    failed "REPL: tmux new-session failed"
  else
    pane=""
    for _ in $(seq 1 60); do
      sleep 0.25
      pane="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null)"
      grep -qE '❯|__EXIT_CODE=' <<<"$pane" && break
    done
    if grep -qE "$CRASH_RE" <<<"$pane"; then
      failed "REPL: crash on start" "$pane"
    elif grep -q '__EXIT_CODE=' <<<"$pane"; then
      if grep -qE 'no provider credentials|no credentials for provider' <<<"$pane"; then
        pass "REPL starts and stops at the credentials check"
      else
        failed "REPL exited before the credentials check" "$pane"
      fi
    elif grep -q '❯' <<<"$pane"; then
      pass "REPL draws its prompt"
    else
      failed "REPL: no prompt and no exit after 15s" "$pane"
    fi
  fi
else
  echo "e2e: skip  REPL (tmux not installed)"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "e2e: $failures check(s) failed for $SRC_BIN" >&2
  exit 1
fi
echo "e2e: all checks passed for $SRC_BIN"
