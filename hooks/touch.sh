#!/bin/sh
# UserPromptSubmit: every prompt of yours touches this session's record. That tells the
# daemon which terminal you are working in, and it delivers the invite there. No Bun, no
# anything: read the event's session_id and a touch.
id=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$id" ] || exit 0
safe=$(printf '%s' "$id" | tr -c 'A-Za-z0-9._-\n' '_')
f="${SPOOCHIE_HOME:-$HOME/.claude/spoochie}/sessions/$safe.json"
[ -f "$f" ] && touch "$f"
exit 0
