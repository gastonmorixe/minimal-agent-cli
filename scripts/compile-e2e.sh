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
#   1. `--help` exits 0 and shows the version in package.json (a binary
#      that reads package.json from disk shows 0.0.0). `--help --json` has a
#      `commands` section with rows (structure, not heading text).
#   2. `plugins` exits 0, and the fixture provider plugin in HOME loads from
#      disk: it imports core by package name with `import` and `require()`,
#      checks that both give the same class, and writes a marker file.
#   3. The cwd holds a hostile `bunfig.toml` (a `preload` script) and a
#      `.env`. The binary must not run the preload or load the `.env`.
#   4. `-p` with no credentials exits non-zero at the credentials check.
#   5. The interactive REPL in tmux starts and stops at the credentials
#      check (the fresh HOME has none). Skipped without tmux.
#   6. Embedded plugins: with an EMPTY HOME and no plugin dir anywhere,
#      `plugins` lists >= 40 plugins and `providers` lists 13.
#   7. A user-tier plugin with the id of an embedded one shadows it.
#   8. `__run`: a path or an unknown id exits 64. `__run ma-bg/runner`
#      reaches the runner (its missing-env error, exit 2).
#   9. Self-spawn with no bun on PATH (`PATH=/usr/bin:/bin`), against a
#      local mock model (`compile-e2e-mock-model.ts`, run by the binary
#      itself as BUN_BE_BUN=1): one turn calls BackgroundRun and
#      SubAgentsSpawnAgent. The job log shows the command ran with no
#      BUN_BE_BUN and no bun. The child agent (the binary spawning itself)
#      calls the model.
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
MOCK_PID=""
CRASH_RE='Cannot find package|ENOENT|at .*\(/\$bunfs/|^error: |panic'
SESSION="ma-e2e-$$-$RANDOM"
CHILD=""
WATCHER=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimal-agent-e2e-XXXXXX")" || exit 2
WORK="$(cd "$WORK" && pwd -P)"

cleanup() {
  [[ -n "$CHILD" ]] && kill -KILL "$CHILD" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && kill -KILL "$MOCK_PID" 2>/dev/null
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

# run NAME ARGS...: run the binary in the project dir with a time limit
# (RUN_TIMEOUT, default TIMEOUT_SECS). Sets OUT (stdout + stderr) and CODE
# (124 on timeout).
run() {
  local name="$1"
  shift
  local out_file="$WORK/out-$failures-$RANDOM"
  rm -f "$WORK/timed-out"
  (cd "$PROJECT" && exec "${ENV[@]}" TERM=dumb NO_COLOR=1 "$BIN" "$@") \
    </dev/null >"$out_file" 2>&1 &
  CHILD=$!
  local limit="${RUN_TIMEOUT:-$TIMEOUT_SECS}"
  (
    sleep "$limit"
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
    failed "$name: no exit after ${limit}s" "$OUT"
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
# The structure check reads `--help --json` (sections[].id), not a heading
# string, so a text rewrite of help cannot break the gate. The JSON is parsed
# with the binary itself (BUN_BE_BUN=1 makes it act as the bun CLI), so the
# check needs no bun or jq on the host.
if run "--help" --help; then
  if [[ "$CODE" != "0" ]]; then
    failed "--help: exit $CODE" "$OUT"
  else
    pass "--help"
  fi
  if [[ -n "$WANT_VERSION" ]] && ! grep -q "v$WANT_VERSION" <<<"$OUT"; then
    failed "--help: version is not v$WANT_VERSION (package.json)" "$(head -n 3 <<<"$OUT")"
  else
    pass "--help shows v$WANT_VERSION"
  fi
fi
if run "--help --json" --help --json; then
  if [[ "$CODE" != "0" ]]; then
    failed "--help --json: exit $CODE" "$OUT"
  else
    HELP_JSON="$WORK/help.json"
    printf '%s' "$OUT" >"$HELP_JSON"
    # Prints "<version> <ids>" or exits non-zero on bad JSON.
    shape="$(env -i "PATH=/usr/bin:/bin" BUN_BE_BUN=1 "$BIN" -e '
      const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
      const ids = (j.sections ?? []).map((s) => s.id)
      const cmds = (j.sections ?? []).find((s) => s.id === "commands")
      const rows = (cmds?.groups ?? []).flatMap((g) => g.rows ?? []).length + (cmds?.rows ?? []).length
      console.log(`${j.program?.version ?? ""} ${rows} ${ids.join(",")}`)
    ' "$HELP_JSON" 2>&1)"
    read -r json_version json_rows json_ids <<<"$shape"
    if [[ ",${json_ids:-}," != *",commands,"* ]]; then
      failed "--help --json: no commands section" "$shape"
    elif [[ "${json_rows:-0}" -lt 1 ]] 2>/dev/null; then
      failed "--help --json: the commands section has no rows" "$shape"
    elif [[ -n "$WANT_VERSION" && "$json_version" != "$WANT_VERSION" ]]; then
      failed "--help --json: program.version is $json_version, not $WANT_VERSION" "$shape"
    else
      pass "--help --json has a commands section ($json_rows rows)"
    fi
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

# 6. Embedded plugins from an empty HOME, no plugin dir anywhere.
EMPTY_HOME="$WORK/empty-home"
mkdir -p "$EMPTY_HOME"
EMPTY_ENV=(env -i "PATH=/usr/bin:/bin" "HOME=$EMPTY_HOME" "LANG=$UTF8_LANG"
  "MINIMAL_AGENT_NO_PLUGIN_SYNC=1" "MINIMAL_AGENT_NO_BINARY_SETUP=1")
# Strip ANSI SGR codes (the listings dim their footer even with NO_COLOR).
plain() { sed $'s/\x1b\\[[0-9;]*m//g' <<<"$1"; }
# run_empty NAME ARGS...: `run` with the empty-HOME env.
run_empty() {
  local saved=("${ENV[@]}")
  ENV=("${EMPTY_ENV[@]}")
  run "$@"
  local rc=$?
  ENV=("${saved[@]}")
  return $rc
}
if run_empty "plugins (empty HOME)" plugins; then
  n="$(plain "$OUT" | grep -oE '^ *[0-9]+ plugins' | grep -oE '[0-9]+' | head -n 1)"
  if [[ "$CODE" == "0" && "${n:-0}" -ge 40 ]]; then
    pass "embedded: $n plugins with an empty HOME"
  else
    failed "embedded: plugins listed ${n:-none} (exit $CODE), want >= 40" "$OUT"
  fi
fi
if run_empty "providers (empty HOME)" providers; then
  n="$(plain "$OUT" | grep -oE '^ *[0-9]+ providers' | grep -oE '[0-9]+' | head -n 1)"
  if [[ "$CODE" == "0" && "${n:-0}" == "13" ]]; then
    pass "embedded: 13 providers with an empty HOME"
  else
    failed "embedded: providers listed ${n:-none} (exit $CODE), want 13" "$OUT"
  fi
fi
if [[ -e "$EMPTY_HOME/.minimal-agent/plugins" ]]; then
  failed "embedded: the binary created a user plugins dir (a first-run clone?)"
fi

# 7. A user-tier copy of an embedded plugin id shadows it.
SHADOW_DIR="$EMPTY_HOME/.minimal-agent/plugins/ma-tps-plugin"
mkdir -p "$SHADOW_DIR"
printf '%s\n' '{ "id": "tps", "name": "TPS user override", "version": "0.0.1", "description": "e2e shadow" }' \
  >"$SHADOW_DIR/manifest.json"
if run_empty "plugins (user shadow)" plugins; then
  if grep -q "TPS user override" <<<"$OUT" && [[ "$(plain "$OUT" | grep -cE '^ *tps ')" == "1" ]]; then
    pass "a user-tier plugin shadows the embedded one by id"
  else
    failed "user-tier tps did not shadow the embedded tps" "$(grep -E 'tps|plugins \(' <<<"$OUT")"
  fi
fi
rm -rf "$EMPTY_HOME/.minimal-agent/plugins"

# 8. __run: script ids only, never paths.
for bad in "../x" "/tmp/x.ts" "ma-bg/nope"; do
  if run_empty "__run $bad" __run "$bad"; then
    if [[ "$CODE" == "64" ]] && grep -q "unknown embedded script" <<<"$OUT"; then
      pass "__run $bad exits 64"
    else
      failed "__run $bad: exit $CODE, want 64" "$OUT"
    fi
  fi
done
if run_empty "__run ma-bg/runner" __run ma-bg/runner; then
  if [[ "$CODE" == "2" ]] && grep -q "MA_BG_JOB_ID is required" <<<"$OUT"; then
    pass "__run ma-bg/runner dispatches to the embedded runner"
  else
    failed "__run ma-bg/runner: exit $CODE, want 2 with the runner's env error" "$OUT"
  fi
fi

# 9. BackgroundRun + SpawnAgent against a mock model, no bun on PATH.
if PATH=/usr/bin:/bin command -v bun >/dev/null 2>&1; then
  echo "e2e: note  bun is in /usr/bin or /bin; check 9 runs but cannot prove 'no bun'"
fi
MOCK_DIR="$WORK/mock"
mkdir -p "$MOCK_DIR"
cp "$CLI_DIR/scripts/compile-e2e-mock-model.ts" "$MOCK_DIR/mock-model.ts" || exit 2
BG_CMD='echo bg-hi; echo "be=${BUN_BE_BUN-unset}"; command -v bun >/dev/null && echo bun=found || echo bun=none'
# The mock runs on the binary itself (BUN_BE_BUN=1), so no bun is needed.
(cd "$MOCK_DIR" && exec env -i "PATH=/usr/bin:/bin" BUN_BE_BUN=1 "$BIN" mock-model.ts \
  "$MOCK_DIR/port" "$MOCK_DIR/log" "$BG_CMD") >"$MOCK_DIR/stdout" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do
  [[ -s "$MOCK_DIR/port" ]] && break
  sleep 0.25
done
if [[ ! -s "$MOCK_DIR/port" ]]; then
  failed "mock model did not start" "$(cat "$MOCK_DIR/stdout")"
else
  MOCK_URL="http://127.0.0.1:$(cat "$MOCK_DIR/port")"
  rm -rf "$EMPTY_HOME" && mkdir -p "$EMPTY_HOME"
  if RUN_TIMEOUT=90 run_empty "-p self-spawn (mock model)" --skip-quota \
    --provider generic-endpoint --endpoint "$MOCK_URL" --format openai-chat-completions \
    --auth-type none --model mock-model --mode none -p "go"; then
    mock_log="$(cat "$MOCK_DIR/log" 2>/dev/null)"
    job_log="$(cat "$EMPTY_HOME"/.minimal-agent/sessions/*.bgjobs/*.log 2>/dev/null)"
    if [[ "$CODE" != "0" ]]; then
      failed "self-spawn run: exit $CODE" "$OUT"$'\n'"$mock_log"
    fi
    if grep -q "parent-request 1 bg=true spawn=true" <<<"$mock_log"; then
      pass "the request carries the embedded BackgroundRun and SubAgentsSpawnAgent tools"
    else
      failed "the first request lacks BackgroundRun or SubAgentsSpawnAgent" "$mock_log"
    fi
    if grep -q "^bg-hi$" <<<"$job_log" && grep -q "^be=unset$" <<<"$job_log" &&
      grep -q "^bun=none$" <<<"$job_log"; then
      pass "BackgroundRun job ran via __run ma-bg/runner: no BUN_BE_BUN, no bun on PATH"
    else
      failed "BackgroundRun job log is not as expected" "job log: $job_log"$'\n'"$mock_log"
    fi
    if grep -q "child-request" <<<"$mock_log"; then
      pass "SpawnAgent: the child agent (the binary itself) called the model"
    else
      failed "SpawnAgent: no child request reached the mock model" "$OUT"$'\n'"$mock_log"
    fi
  fi
fi
kill -KILL "$MOCK_PID" 2>/dev/null
MOCK_PID=""

if [[ "$failures" -gt 0 ]]; then
  echo "e2e: $failures check(s) failed for $SRC_BIN" >&2
  exit 1
fi
echo "e2e: all checks passed for $SRC_BIN"
