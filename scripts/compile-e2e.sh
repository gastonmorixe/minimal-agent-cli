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
#      `plugins` lists >= 40 plugins and `providers` lists 14.
#   7. A user-tier plugin with the id of an embedded one shadows it.
#   8. `__run`: a path or an unknown id exits 64. `__run ma-bg/runner`
#      reaches the runner (its missing-env error, exit 2).
#   9. Self-spawn with no bun on PATH (`PATH=/usr/bin:/bin`), against a
#      local mock model (`compile-e2e-mock-model.ts`, run by the binary
#      itself as BUN_BE_BUN=1): one turn calls BackgroundRun and
#      SubAgentsSpawnAgent. The job log shows the command ran with no
#      BUN_BE_BUN and no bun. The child agent (the binary spawning itself)
#      calls the model. The run uses `--formatter cat` (plain text output).
#  10. macOS only, a darwin binary with an embedded computer-use helper:
#      against a second mock model (`compile-e2e-mock-computer.ts`), one turn
#      calls `Computer` `{"action":"ping"}` with a test MINIMAL_AGENT_HOME and
#      test CUD_SOCK, CUD_DIR, CUD_LOG and CUD_ACTION_LOG. The helper is
#      extracted to `<home>/cache/embedded/<buildId>/ma-computer-use-plugin/
#      native/build/ComputerUseHelper` with mode 755, passes `codesign --verify
#      --strict`, answers the ping (protocol 2, its own path), and passes
#      `--selftest` when the host runs the arch natively. The check stops only
#      the helper pid that the ping gave. A ping needs no TCC grant. Skipped
#      on other hosts, with MA_COMPILE_NO_HELPER=1, or when the binary embeds
#      no helper.
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
# Check 10: the helper pid from our own ping, the extracted file, and a
# socket dir outside WORK (only when the path in WORK is too long).
CU_PID=""
CU_FILE=""
CU_SOCK_DIR=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimal-agent-e2e-XXXXXX")" || exit 2
WORK="$(cd "$WORK" && pwd -P)"

cleanup() {
  [[ -n "$CHILD" ]] && kill -KILL "$CHILD" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && kill -KILL "$MOCK_PID" 2>/dev/null
  [[ -n "$WATCHER" ]] && kill "$WATCHER" 2>/dev/null
  cu_stop
  if command -v tmux >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null
  fi
  [[ -n "$CU_SOCK_DIR" ]] && rm -rf "$CU_SOCK_DIR"
  rm -rf "$WORK"
}

# cu_running: true while CU_PID runs CU_FILE (so a reused pid is never hit).
cu_running() {
  [[ -n "$CU_PID" && -n "$CU_FILE" ]] || return 1
  local cmd
  cmd="$(ps -ww -p "$CU_PID" -o command= 2>/dev/null)"
  [[ "$cmd" == "$CU_FILE"* ]]
}

# cu_stop: stop the check 10 helper, the pid that our own ping gave, and no
# other process. SIGTERM, then SIGKILL after 5 s.
cu_stop() {
  if cu_running; then
    kill -TERM "$CU_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      cu_running || break
      sleep 0.25
    done
    cu_running && kill -KILL "$CU_PID" 2>/dev/null
  fi
  CU_PID=""
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
  if [[ "$CODE" == "0" && "${n:-0}" == "14" ]]; then
    pass "embedded: 14 providers with an empty HOME"
  else
    failed "embedded: providers listed ${n:-none} (exit $CODE), want 14" "$OUT"
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
  # `--formatter cat`: plain-text output (no markdown renderer), so the
  # captured $OUT is readable and greppable when a check fails.
  if RUN_TIMEOUT=90 run_empty "-p self-spawn (mock model)" --skip-quota --formatter cat \
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
# Reap it, so bash prints no "Killed: 9" job notice while check 10 runs.
wait "$MOCK_PID" 2>/dev/null
MOCK_PID=""

# 10. The embedded computer-use helper (macOS host, darwin binary), against
# a second mock model: one turn calls Computer {"action":"ping"}. A test
# MINIMAL_AGENT_HOME and test CUD_* paths, never the default socket.
CU_HOME="$WORK/cu-home"
CU_SOCK=""

# cu_own_ping SOCK: the pid that the helper on SOCK gives to a ping, or
# nothing. Only for a run that ended before its ping result reached the mock.
cu_own_ping() {
  env -i "PATH=/usr/bin:/bin" BUN_BE_BUN=1 "$BIN" -e '
    fetch("http://localhost/ping", {
      unix: process.argv[1], method: "POST", body: "{}",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
    }).then((r) => r.json()).then((j) => console.log(j.pid ?? ""), () => console.log(""))
  ' "$1" 2>/dev/null
}

# cu_selftest: run the extracted helper with --selftest (60 s limit). Sets
# OUT and CODE (124 on timeout).
cu_selftest() {
  local out_file="$WORK/cu/selftest.out"
  env -i "PATH=/usr/bin:/bin" "HOME=$CU_HOME" "$CU_FILE" --selftest >"$out_file" 2>&1 &
  local pid=$!
  for _ in $(seq 1 240); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    CODE=124
  else
    wait "$pid"
    CODE=$?
  fi
  OUT="$(cat "$out_file")"
}

# cu_check TARGET: check 10 for a darwin binary that embeds the helper.
cu_check() {
  local target="$1"
  local dir="$WORK/cu"
  mkdir -p "$dir/state" "$dir/mock" "$CU_HOME"
  CU_SOCK="$dir/cud.sock"
  # sun_path holds 104 bytes with the NUL.
  if (($(printf '%s' "$CU_SOCK" | wc -c) >= 104)); then
    CU_SOCK_DIR="$(mktemp -d "$(dirname "$WORK")/ma-cu-XXXXXX")" || exit 2
    CU_SOCK="$CU_SOCK_DIR/cud.sock"
  fi
  if (($(printf '%s' "$CU_SOCK" | wc -c) >= 104)); then
    failed "computer-use: socket path $CU_SOCK is 104 bytes or more; set TMPDIR to a shorter dir"
    return
  fi
  cp "$CLI_DIR/scripts/compile-e2e-mock-computer.ts" "$dir/mock/mock-computer.ts" || exit 2
  (cd "$dir/mock" && exec env -i "PATH=/usr/bin:/bin" BUN_BE_BUN=1 "$BIN" mock-computer.ts \
    "$dir/mock/port" "$dir/mock/log") >"$dir/mock/stdout" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 40); do
    [[ -s "$dir/mock/port" ]] && break
    sleep 0.25
  done
  if [[ ! -s "$dir/mock/port" ]]; then
    failed "computer-use: mock model did not start" "$(cat "$dir/mock/stdout")"
    return
  fi
  local saved=("${ENV[@]}")
  ENV=(env -i "PATH=/usr/bin:/bin" "HOME=$CU_HOME" "LANG=$UTF8_LANG"
    "MINIMAL_AGENT_HOME=$CU_HOME/.minimal-agent" "MINIMAL_AGENT_NO_PLUGIN_SYNC=1"
    "MINIMAL_AGENT_NO_BINARY_SETUP=1" "CUD_SOCK=$CU_SOCK" "CUD_DIR=$dir/state"
    "CUD_LOG=$dir/daemon.log" "CUD_ACTION_LOG=$dir/actions.log")
  local ran=0
  RUN_TIMEOUT=90 run "-p Computer ping (mock model)" --skip-quota --formatter cat \
    --provider generic-endpoint --endpoint "http://127.0.0.1:$(cat "$dir/mock/port")" \
    --format openai-chat-completions --auth-type none --model mock-model --mode none \
    -p "go" && ran=1
  ENV=("${saved[@]}")
  local run_out="$OUT" run_code="$CODE"
  local mock_log ping_line ping_path f n=0
  mock_log="$(cat "$dir/mock/log" 2>/dev/null)"
  ping_line="$(grep -m 1 '^ping pid=' <<<"$mock_log")"
  ping_path="${ping_line##* path=}"
  [[ "$ping_line" =~ pid=([0-9]+) ]] && CU_PID="${BASH_REMATCH[1]}"
  for f in "$CU_HOME"/.minimal-agent/cache/embedded/*/ma-computer-use-plugin/native/build/ComputerUseHelper; do
    [[ -f "$f" ]] || continue
    CU_FILE="$f"
    n=$((n + 1))
  done
  # cu_stop needs a path to match the pid against.
  [[ -z "$CU_FILE" && -n "$ping_line" ]] && CU_FILE="$ping_path"
  if [[ -z "$CU_PID" && -S "$CU_SOCK" && -n "$CU_FILE" ]]; then
    CU_PID="$(cu_own_ping "$CU_SOCK")"
    [[ "$CU_PID" =~ ^[0-9]+$ ]] || CU_PID=""
  fi

  if [[ "$ran" == 1 && "$run_code" != "0" ]]; then
    failed "computer-use run: exit $run_code" "$(printf '%s\n%s' "$run_out" "$mock_log")"
  fi
  if grep -qx 'request 1 computer=true' <<<"$mock_log"; then
    pass "computer-use: the request carries the embedded Computer tool"
  else
    failed "computer-use: the first request lacks the Computer tool" "$mock_log"
  fi
  if [[ "$n" != "1" ]]; then
    failed "computer-use: want 1 extracted helper in the test home, found $n" \
      "$(find "$CU_HOME/.minimal-agent/cache" -maxdepth 6 2>/dev/null | head -n 20)"
  else
    pass "computer-use: helper extracted to cache/embedded/<buildId>/ma-computer-use-plugin/native/build/ComputerUseHelper"
    local mode
    mode="$(stat -f %Lp "$CU_FILE" 2>&1)"
    if [[ "$mode" == "755" ]]; then
      pass "computer-use: the extracted helper has mode 755"
    else
      failed "computer-use: the extracted helper has mode $mode, want 755"
    fi
    local sig
    if sig="$(codesign --verify --strict "$CU_FILE" 2>&1)"; then
      pass "computer-use: codesign --verify --strict passes on the extracted helper"
    else
      failed "computer-use: codesign --verify --strict fails on the extracted helper" "$sig"
    fi
    local arch
    arch="$(uname -m)"
    if [[ ("$arch" == "arm64" && "$target" == "darwin-arm64") ||
      ("$arch" == "x86_64" && "$target" == "darwin-x64") ]]; then
      cu_selftest
      if [[ "$CODE" == "0" ]] && grep -qE 'selftest: ([0-9]+)/\1 passed' <<<"$OUT"; then
        pass "computer-use: the extracted helper passes --selftest ($(grep -oE '[0-9]+/[0-9]+ passed' <<<"$OUT" | head -n 1))"
      else
        failed "computer-use: --selftest of the extracted helper: exit $CODE" "$OUT"
      fi
    else
      echo "e2e: skip  computer-use --selftest (a $target helper on a $arch host)"
    fi
  fi
  if [[ -z "$ping_line" ]]; then
    failed "computer-use: no ping result reached the mock model" \
      "$(printf '%s\n%s\n%s' "$run_out" "$mock_log" "$(cat "$dir/daemon.log" 2>/dev/null)")"
  else
    if grep -q ' protocol=2 ' <<<"$ping_line"; then
      pass "computer-use: Computer ping answered by the helper (pid $CU_PID, protocol 2)"
    else
      failed "computer-use: the ping does not give protocol 2" "$ping_line"
    fi
    if [[ "$n" == "1" && "$ping_path" == "$CU_FILE" ]]; then
      pass "computer-use: the helper that answers runs the extracted file"
    else
      failed "computer-use: the ping binary.path is not the extracted file" \
        "$(printf 'ping: %s\nfile: %s' "$ping_path" "$CU_FILE")"
    fi
  fi
  if grep -qF "listening on $CU_SOCK" "$dir/daemon.log" 2>/dev/null; then
    pass "computer-use: the helper listens on the test socket (CUD_SOCK) and logs to CUD_LOG"
  else
    failed "computer-use: CUD_LOG has no 'listening on' line for the test socket" \
      "$(cat "$dir/daemon.log" 2>/dev/null)"
  fi
  if [[ -n "$CU_PID" ]]; then
    local pid="$CU_PID"
    cu_stop
    CU_PID="$pid"
    if cu_running; then
      failed "computer-use: helper pid $pid did not stop"
    else
      CU_PID=""
      rm -f "$CU_SOCK"
      pass "computer-use: helper pid $pid stopped, test socket removed"
    fi
  fi
}

# The embedded file name of the helper in the binary: Bun names an extra
# file `/$bunfs/root/ComputerUseHelper-<hash>.`. A binary with no helper has
# no such name.
CU_EMBED_NAME="/\$bunfs/root/ComputerUseHelper-"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "e2e: skip  computer-use helper (not a macOS host)"
elif run_empty "--version --json" --version --json; then
  cu_target="$(sed -n 's/^  "target": "\([^"]*\)".*/\1/p' <<<"$OUT" | head -n 1)"
  if [[ "$CODE" != "0" || -z "$cu_target" ]]; then
    failed "--version --json: exit $CODE, no target" "$OUT"
  elif [[ "$cu_target" != darwin-* ]]; then
    echo "e2e: skip  computer-use helper (the binary target is $cu_target)"
  elif ! LC_ALL=C grep -a -q -F "$CU_EMBED_NAME" "$BIN"; then
    if [[ "${MA_COMPILE_NO_HELPER:-}" == "1" ]]; then
      echo "e2e: skip  computer-use helper (MA_COMPILE_NO_HELPER=1, the binary embeds no helper)"
    else
      echo "e2e: skip  computer-use helper (the binary embeds no helper: no toolchain or no sources, see the compile log)"
    fi
  else
    cu_check "$cu_target"
  fi
fi
if [[ -n "$MOCK_PID" ]]; then
  kill -KILL "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
fi
MOCK_PID=""
cu_stop
[[ -n "$CU_SOCK" ]] && rm -f "$CU_SOCK"

if [[ "$failures" -gt 0 ]]; then
  echo "e2e: $failures check(s) failed for $SRC_BIN" >&2
  exit 1
fi
echo "e2e: all checks passed for $SRC_BIN"
