#!/bin/sh
# Registers this session with spoochie and starts the daemon if it is not running.
# Claude Code exports CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN before running any hook.
#
# Without Bun, it downloads the binary from the release for THIS plugin version (not
# "latest"), checks its SHA-256 against the same release's SHA256SUMS, and keeps it with
# the version in its name: that way updating the plugin updates the binary, and a binary
# tampered with on the way does not run. What this hook prints goes into the session's
# context, so if something is missing that person's Claude tells them.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_SP="${SPOOCHIE_HOME:-$HOME/.claude/spoochie}"
DIR="$HOME_SP/bin"
# What this hook prints goes into THAT session's context and stays there. If it fails
# and the person restarts, no trace is left: the spoochie someone opens to them will not
# arrive and nobody will know why. So every start also leaves a line on disk, which
# `doctor` reads. The file name and the status word ("ok" or "fallo") stay as they are:
# doctor parses them.
STATUS="$HOME_SP/arranque.txt"
note() {
  mkdir -p "$HOME_SP" 2>/dev/null && chmod 700 "$HOME_SP" 2>/dev/null
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" > "$STATUS" 2>/dev/null
  chmod 600 "$STATUS" 2>/dev/null
}
VERSION=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -1)
BIN="$DIR/spoochie-$VERSION"
# The repo to download the binary from: the same one the plugin was installed from. A
# fork changes it in .claude-plugin/marketplace.json ("origin") and nothing here changes.
REPO=$(sed -n 's/.*"origin" *: *"\([^"]*\)".*/\1/p' "$ROOT/.claude-plugin/marketplace.json" | head -1)
[ -n "$REPO" ] || REPO="edugargar/spoochie"
REPO="${SPOOCHIE_ORIGIN:-${SPOOCHIE_ORIGEN:-$REPO}}"

if [ ! -x "$BIN" ] && ! command -v bun >/dev/null 2>&1; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m)
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  mkdir -p "$DIR" && chmod 700 "$DIR"
  base="https://github.com/$REPO/releases/download/v$VERSION"
  name="spoochie-$os-$arch"
  if curl -fsSL "$base/$name" -o "$BIN.tmp" && curl -fsSL "$base/SHA256SUMS" -o "$BIN.sums"; then
    want=$(awk -v n="$name" '$2 == n { print $1 }' "$BIN.sums")
    got=$(shasum -a 256 "$BIN.tmp" 2>/dev/null | awk '{ print $1 }')
    [ -z "$got" ] && got=$(sha256sum "$BIN.tmp" 2>/dev/null | awk '{ print $1 }')
    rm -f "$BIN.sums"
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      chmod +x "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
      # Binaries from earlier versions are no longer needed. Newer ones may be in use.
      sh "$ROOT/hooks/prune-binaries.sh" "$DIR" "$VERSION"
      note ok "binary $VERSION for $os-$arch downloaded and verified"
      echo "spoochie: downloaded and verified the spoochie $VERSION binary for $os-$arch, no Bun needed."
    else
      rm -f "$BIN.tmp"
      note fallo "the $VERSION binary for $os-$arch does not match the release SHA256SUMS (got ${got:-nothing}, expected ${want:-nothing}); not running it"
      echo "spoochie: the downloaded binary for $os-$arch did NOT match the release checksum (got ${got:-nothing}, expected ${want:-nothing}). Not running it. Tell the user; installing Bun (curl -fsSL https://bun.sh/install | bash) works as an alternative."
      exit 0
    fi
  else
    rm -f "$BIN.tmp" "$BIN.sums"
    note fallo "no Bun, and could not download the $VERSION binary for $os-$arch from $base"
    echo "spoochie: Bun is not installed and the $VERSION binary for $os-$arch could not be downloaded from $base. Tell the user to install Bun (curl -fsSL https://bun.sh/install | bash) and restart Claude Code."
    exit 0
  fi
fi
note ok "session registered with spoochie $VERSION"
exec "$ROOT/bin/spoochie" register
