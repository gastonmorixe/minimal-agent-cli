#!/usr/bin/env bash
# Entry script for the minimal-agent CLI from source.
#
#   ./ma --help            # every command and flag
#   ./ma                   # interactive REPL
#   ./ma -p "hi"           # one-shot prompt
#
# Symlink it onto PATH to run from anywhere (it resolves its own location
# through symlinks and keeps the caller's working directory):
#
#   ln -sf "$PWD/ma" ~/.local/bin/ma
set -euo pipefail

# Resolve this script's real directory, following symlinks (macOS-safe: no
# reliance on GNU `readlink -f`).
src="${BASH_SOURCE[0]}"
while [[ -L "$src" ]]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
root="$(cd -P "$(dirname "$src")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "ma: bun is required (https://bun.sh)" >&2
  exit 127
fi

exec bun "$root/src/index.ts" "$@"
