#!/bin/sh
# Deletes the spoochie binaries in DIR that are OLDER than VERSION, and the unversioned one.
#   sh prune-binaries.sh DIR VERSION
# Only older ones: a window opened by a newer daemon runs the SessionStart hook of whatever
# plugin is installed, and that hook used to delete every other binary, the daemon's
# included. The aside's gatekeeper then pointed at a missing file (seen in a real test).
DIR="$1"; VERSION="$2"
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$1" ]; }
for f in "$DIR"/spoochie-*; do
  [ -e "$f" ] || continue
  v="${f##*/spoochie-}"
  case "$v" in *.tmp|*.sums) continue ;; esac
  older "$v" "$VERSION" && rm -f "$f"
done
rm -f "$DIR/spoochie"
