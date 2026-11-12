#!/bin/sh
# Install the minimal-agent binary from the GitHub Releases of the PRIVATE
# repo gastonmorixe/minimal-agent-cli. POSIX sh: Debian minimal (curl or
# wget, tar, gzip) and macOS.
#
# The repo is private, so even this script needs a token to fetch:
#
#   gh api repos/gastonmorixe/minimal-agent-cli/contents/scripts/install.sh \
#     -H 'Accept: application/vnd.github.raw' | sh
#
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
#     -H 'Accept: application/vnd.github.raw' \
#     https://api.github.com/repos/gastonmorixe/minimal-agent-cli/contents/scripts/install.sh \
#     | sh -s -- --channel nightly
#
# Options:
#   --channel stable|nightly  release channel (default stable)
#   --version <x.y.z|tag>     one exact release (v0.2.0, 0.1.0-nightly.<stamp>)
#   --dir <dir>               install dir (default ~/.local/bin, else /usr/local/bin)
#   -h, --help                this text
#
# Token, first one set wins: MINIMAL_AGENT_GITHUB_TOKEN, GITHUB_TOKEN,
# GH_TOKEN, then `gh auth token`. The token goes only to the GitHub API: it
# is passed through a header file (curl) or a wgetrc (wget), never argv,
# and the redirect to the signed storage URL is followed without it.
#
# Flow: detect os/arch/libc/AVX2, find the release, download
# minimal-agent-<label>-<target>.tar.gz and SHA256SUMS, verify the sha256,
# extract the binary, install it (0755) with an atomic rename, keep the
# previous one as minimal-agent.old, run `minimal-agent version`.
#
# Exit codes: 0 installed, 1 failed, 2 bad arguments, 3 no token or no
# access, 4 no release or no build for this host, 5 dir not writable.
#
# Test hooks: MINIMAL_AGENT_INSTALL_API (API base, default
# https://api.github.com), MINIMAL_AGENT_INSTALL_HTTP=curl|wget.

set -eu

REPO="gastonmorixe/minimal-agent-cli"
API="${MINIMAL_AGENT_INSTALL_API:-https://api.github.com}"
CHANNEL="stable"
VERSION=""
DIR=""
DIR_EXPLICIT=0

say() { printf '%s\n' "$*"; }
err() { printf 'install.sh: %s\n' "$*" >&2; }
die() {
  code="$1"
  shift
  err "$*"
  exit "$code"
}

usage() {
  cat <<'EOF_USAGE'
Install minimal-agent from the private gastonmorixe/minimal-agent-cli releases.

usage: install.sh [--channel stable|nightly] [--version <x.y.z|tag>] [--dir <dir>]

  --channel stable|nightly  release channel (default stable)
  --version <x.y.z|tag>     one exact release (v0.2.0, 0.1.0-nightly.<stamp>)
  --dir <dir>               install dir (default ~/.local/bin, else /usr/local/bin)

Needs a token with read access to the private repo: MINIMAL_AGENT_GITHUB_TOKEN,
GITHUB_TOKEN, GH_TOKEN, or a logged-in gh (gh auth token).
Exit codes: 0 installed, 1 failed, 2 bad arguments, 3 no token or no access,
4 no release or no build for this host, 5 dir not writable.
EOF_USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --channel)
      [ $# -ge 2 ] || die 2 "--channel needs a value"
      CHANNEL="$2"
      shift 2
      ;;
    --channel=*)
      CHANNEL="${1#*=}"
      shift
      ;;
    --version)
      [ $# -ge 2 ] || die 2 "--version needs a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --dir)
      [ $# -ge 2 ] || die 2 "--dir needs a value"
      DIR="$2"
      DIR_EXPLICIT=1
      shift 2
      ;;
    --dir=*)
      DIR="${1#*=}"
      DIR_EXPLICIT=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die 2 "unknown argument: $1 (see --help)" ;;
  esac
done

case "$CHANNEL" in
  stable | nightly) ;;
  *) die 2 "--channel $CHANNEL: use stable or nightly" ;;
esac

# --- tools -----------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

HTTP="${MINIMAL_AGENT_INSTALL_HTTP:-}"
if [ -z "$HTTP" ]; then
  if have curl; then HTTP=curl; elif have wget; then HTTP=wget; else die 1 "need curl or wget"; fi
fi
have "$HTTP" || die 1 "$HTTP not found"
have tar || die 1 "need tar"
have gzip || die 1 "need gzip"
if have sha256sum; then
  SHA="sha256sum"
elif have shasum; then
  SHA="shasum -a 256"
else
  die 1 "need sha256sum or shasum"
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t minimal-agent-install)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# --- token -----------------------------------------------------------------

TOKEN="${MINIMAL_AGENT_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
if [ -z "$TOKEN" ] && have gh; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  err "no GitHub token: minimal-agent releases live on $REPO, which is a private repo."
  err "Provide a token with read access to it, one of:"
  err "  export GITHUB_TOKEN=<token>   (or GH_TOKEN, MINIMAL_AGENT_GITHUB_TOKEN)"
  err "  gh auth login                 (then this script uses gh auth token)"
  exit 3
fi

# Auth for the API only, kept out of argv. umask 077 for the files.
OLD_UMASK="$(umask)"
umask 077
printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: minimal-agent-install\n' \
  "$TOKEN" >"$TMP/auth-headers"
printf 'header = Authorization: Bearer %s\nheader = X-GitHub-Api-Version: 2022-11-28\n' \
  "$TOKEN" >"$TMP/wgetrc"
umask "$OLD_UMASK"
unset TOKEN

# http_api URL ACCEPT OUT: GET with the token, no redirects. Prints the
# status code (000 on a network error). A 3xx Location goes to OUT.loc.
http_api() {
  rm -f "$3" "$3.loc"
  if [ "$HTTP" = curl ]; then
    curl -sS -H @"$TMP/auth-headers" -H "Accept: $2" -o "$3" \
      -w '%{http_code} %{redirect_url}' "$1" >"$TMP/curl-w" 2>"$TMP/http-err" || true
    code="$(cut -d' ' -f1 <"$TMP/curl-w")"
    loc="$(cut -d' ' -f2- <"$TMP/curl-w")"
    [ -n "$loc" ] && printf '%s\n' "$loc" >"$3.loc"
  else
    WGETRC="$TMP/wgetrc" wget -q -S --max-redirect=0 --content-on-error \
      --header="Accept: $2" --user-agent=minimal-agent-install -O "$3" "$1" \
      2>"$TMP/http-err" || true
    code="$(sed -n 's/^ *HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$TMP/http-err" | tail -n 1)"
    sed -n 's/^ *[Ll]ocation: *\([^ ]*\).*/\1/p' "$TMP/http-err" | tr -d '\r' | tail -n 1 >"$3.loc"
    [ -s "$3.loc" ] || rm -f "$3.loc"
  fi
  printf '%s' "${code:-000}"
}

# http_plain URL OUT: GET with no token (signed storage URL), follows redirects.
http_plain() {
  if [ "$HTTP" = curl ]; then
    curl -fsSL -A minimal-agent-install -o "$2" "$1"
  else
    : >"$TMP/wgetrc-plain"
    WGETRC="$TMP/wgetrc-plain" wget -q --user-agent=minimal-agent-install -O "$2" "$1"
  fi
}

# api_json PATH OUT: GET an API JSON document. 404 returns 1, others die.
api_json() {
  code="$(http_api "$API/repos/$REPO$1" "application/vnd.github+json" "$2")"
  case "$code" in
    200) return 0 ;;
    404) return 1 ;;
    401) die 3 "GitHub rejected the token (401): invalid or expired" ;;
    403) die 3 "GitHub denied access (403): the token needs read access to the private $REPO (or the rate limit is hit)" ;;
    000) die 1 "cannot reach $API: $(cat "$TMP/http-err" 2>/dev/null)" ;;
    *) die 1 "GitHub API error $code for $1" ;;
  esac
}

# download ASSET_API_URL OUT: the asset bytes, via GitHub's redirect.
download() {
  code="$(http_api "$1" "application/octet-stream" "$2")"
  case "$code" in
    200) return 0 ;;
    301 | 302 | 303 | 307 | 308)
      [ -f "$2.loc" ] || die 1 "redirect with no Location for $1"
      http_plain "$(cat "$2.loc")" "$2" || die 1 "download failed: $1"
      ;;
    *) die 1 "download of $1 failed (HTTP $code)" ;;
  esac
}

# --- JSON without jq ---------------------------------------------------------
# GitHub's JSON, one key per line: split on , { }. Good enough for the
# fields read here (tag_name, draft, prerelease, asset url and name).

json_lines() { tr ',{}' '\012\012\012' <"$1"; }

# asset_url JSON NAME: the API URL of the asset called NAME.
asset_url() {
  json_lines "$1" | awk -v want="$2" '
    /"url" *: *"[^"]*\/releases\/assets\/[0-9]+"/ {
      u = $0; sub(/^[^"]*"url" *: *"/, "", u); sub(/".*$/, "", u); cur = u; next
    }
    /"name" *: *"/ && cur != "" {
      n = $0; sub(/^[^"]*"name" *: *"/, "", n); sub(/".*$/, "", n)
      if (n == want) { print cur; exit }
      cur = ""
    }'
}

# release_tag JSON: the release tag_name.
release_tag() {
  json_lines "$1" | sed -n 's/^[^"]*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -n 1
}

# newest_nightly JSON: the newest published nightly tag of a release list.
newest_nightly() {
  json_lines "$1" | awk '
    /"tag_name" *: *"/ { t = $0; sub(/^[^"]*"tag_name" *: *"/, "", t); sub(/".*$/, "", t); tag = t; d = ""; next }
    /"draft" *: *(true|false)/ { d = ($0 ~ /true/) ? "true" : "false"; next }
    /"prerelease" *: *(true|false)/ {
      p = ($0 ~ /true/) ? "true" : "false"
      if (tag ~ /^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z$/ && d == "false" && p == "true") {
        s = tag; sub(/^.*-nightly\./, "", s); print s " " tag
      }
      tag = ""
    }' | sort -r | head -n 1 | cut -d' ' -f2
}

# --- host --------------------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die 4 "no minimal-agent build for $OS (macOS and Linux only)" ;;
esac
case "$ARCH" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die 4 "no minimal-agent build for arch $ARCH" ;;
esac
# An x64 shell under Rosetta on Apple silicon: install the native build.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  ARCH=arm64
fi

MUSL=0
AVX2=1
if [ "$OS" = linux ]; then
  for f in /lib/ld-musl-*; do
    [ -e "$f" ] && MUSL=1
  done
  if [ "$MUSL" = 0 ] && have ldd && ldd --version 2>&1 | grep -qi musl; then MUSL=1; fi
  if [ "$ARCH" = x64 ] && [ -r /proc/cpuinfo ] && grep -q '^flags' /proc/cpuinfo &&
    ! grep '^flags' /proc/cpuinfo | grep -Eq '[[:space:]]avx2([[:space:]]|$)'; then
    AVX2=0
  fi
fi

if [ "$OS" = darwin ]; then
  TARGETS="darwin-$ARCH"
elif [ "$MUSL" = 1 ]; then
  TARGETS="linux-$ARCH-musl"
elif [ "$ARCH" = arm64 ]; then
  TARGETS="linux-arm64"
elif [ "$AVX2" = 1 ]; then
  TARGETS="linux-x64 linux-x64-baseline"
else
  TARGETS="linux-x64-baseline"
fi

# --- release -----------------------------------------------------------------

REL="$TMP/release.json"
if [ -n "$VERSION" ]; then
  TAG="v${VERSION#v}"
  api_json "/releases/tags/$TAG" "$REL" || {
    api_json "" "$TMP/repo.json" || die 3 "the token cannot see $REPO (private): it needs read access"
    die 4 "no release $TAG on $REPO"
  }
elif [ "$CHANNEL" = stable ]; then
  api_json "/releases/latest" "$REL" || {
    api_json "" "$TMP/repo.json" || die 3 "the token cannot see $REPO (private): it needs read access"
    die 4 "no stable release found on $REPO (none is published yet)"
  }
else
  api_json "/releases?per_page=100" "$TMP/releases.json" ||
    die 3 "the token cannot see $REPO (private): it needs read access"
  NTAG="$(newest_nightly "$TMP/releases.json")"
  [ -n "$NTAG" ] || die 4 "no nightly release found on $REPO (none is published yet)"
  api_json "/releases/tags/$NTAG" "$REL" || die 4 "no release $NTAG on $REPO"
fi
TAG="$(release_tag "$REL")"
[ -n "$TAG" ] || die 1 "could not read the release tag"
LABEL="${TAG#v}"

ASSET=""
ASSET_URL=""
for t in $TARGETS; do
  name="minimal-agent-$LABEL-$t.tar.gz"
  url="$(asset_url "$REL" "$name")"
  if [ -n "$url" ]; then
    ASSET="$name"
    ASSET_URL="$url"
    TARGET="$t"
    break
  fi
done
[ -n "$ASSET" ] || die 4 "$TAG has no build for this host (wanted $TARGETS)"
SUMS_URL="$(asset_url "$REL" "SHA256SUMS")"
[ -n "$SUMS_URL" ] || die 1 "$TAG has no SHA256SUMS asset"

# --- install dir -------------------------------------------------------------

writable_dir() { mkdir -p "$1" 2>/dev/null && [ -w "$1" ]; }

if [ "$DIR_EXPLICIT" = 1 ]; then
  writable_dir "$DIR" ||
    die 5 "$DIR is not writable. Re-run with write access, for example: ... | sudo -E sh -s -- --dir $DIR"
elif [ -n "${HOME:-}" ] && writable_dir "$HOME/.local/bin"; then
  DIR="$HOME/.local/bin"
elif writable_dir /usr/local/bin; then
  DIR=/usr/local/bin
else
  die 5 "neither ~/.local/bin nor /usr/local/bin is writable. Pick a dir with --dir, or: ... | sudo -E sh -s -- --dir /usr/local/bin"
fi

# --- download, verify, install ------------------------------------------------

say "minimal-agent $LABEL ($TARGET) -> $DIR"
download "$SUMS_URL" "$TMP/SHA256SUMS"
download "$ASSET_URL" "$TMP/$ASSET"

WANT="$(awk -v n="$ASSET" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }' "$TMP/SHA256SUMS")"
[ -n "$WANT" ] || die 1 "SHA256SUMS has no line for $ASSET"
GOT="$($SHA "$TMP/$ASSET" | cut -d' ' -f1)"
if [ "$GOT" != "$WANT" ]; then
  die 1 "checksum mismatch for $ASSET: got $GOT, SHA256SUMS says $WANT. Nothing was installed."
fi

mkdir "$TMP/x"
tar -xzf "$TMP/$ASSET" -C "$TMP/x" minimal-agent 2>"$TMP/tar-err" ||
  die 1 "$ASSET has no minimal-agent binary: $(cat "$TMP/tar-err")"
chmod 0755 "$TMP/x/minimal-agent"

DEST="$DIR/minimal-agent"
NEW="$DIR/.minimal-agent.new.$$"
cp "$TMP/x/minimal-agent" "$NEW"
chmod 0755 "$NEW"
if ! (unset BUN_BE_BUN && "$NEW" version --json) >"$TMP/smoke" 2>&1; then
  rm -f "$NEW"
  die 1 "the downloaded binary does not run on this host: $(tail -n 3 "$TMP/smoke")"
fi
if [ -e "$DEST" ]; then
  rm -f "$DEST.old"
  ln "$DEST" "$DEST.old" 2>/dev/null || cp -p "$DEST" "$DEST.old" || true
fi
mv -f "$NEW" "$DEST"

say "installed $DEST"
"$DEST" version || true

if [ "$OS" = darwin ]; then
  say "macOS: release builds are ad-hoc signed unless CI had signing secrets. If Gatekeeper blocks it: xattr -d com.apple.quarantine $DEST"
fi
case ":${PATH:-}:" in
  *":$DIR:"*) ;;
  *) say "note: $DIR is not on PATH. Add it, for example: export PATH=\"$DIR:\$PATH\"" ;;
esac
say "update later with: minimal-agent update"
