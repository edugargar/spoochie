#!/bin/bash
# Simulates two people on two machines using the same Slack account.
#
# Each "machine" is a different SPOOCHIE_HOME: its own daemon, its own session registry
# and its own Slack identity. They share nothing on disk, so the only thing joining
# them is the Slack thread, just like two real laptops.
#
# The pretense: "machine A" claims to be the app's bot user. That is a Slack id
# different from yours, which is all discovery needs to tell your own spoochie from
# someone else's.
#
#   ./scripts/simulate-two-machines.sh up        starts both, with two Claude sessions
#   ./scripts/simulate-two-machines.sh a "..."   talks to machine A's session
#   ./scripts/simulate-two-machines.sh b "..."   talks to machine B's session
#   ./scripts/simulate-two-machines.sh out a|b   last answer from that session
#   ./scripts/simulate-two-machines.sh down      tears everything down
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB="${SPOOCHIE_LAB:-/tmp/spoochie-lab}"
TOKENS="${SPOOCHIE_TOKEN_FILE:?export SPOOCHIE_TOKEN_FILE with the path to the token JSON of your app}"

# A pretends to be the bot user; B is you.
A_USER="${SPOOCHIE_A_USER:-}"
B_USER="${SPOOCHIE_B_USER:-}"

machine() { # name, spoochie_home, slack_user_id, human
  mkdir -p "$2"
  python3 - "$2/config.json" "$3" "$4" "$TOKENS" <<'PY'
import json,sys
json.dump({"guardian": True, "transcript": True, "human": sys.argv[3],
  "slack": {"tokenFile": sys.argv[4], "tokenKey": "userToken", "botTokenKey": "botToken",
            "userId": sys.argv[2], "pollMs": 20000}},
  open(sys.argv[1], "w"), indent=2)
PY
}

# Sample code: each machine has its half of the problem and neither sees the other's,
# which is the situation spoochie exists to solve.
fixtures() {
  mkdir -p "$LAB/repo-a/src" "$LAB/repo-b/src"
  cat > "$LAB/repo-a/src/Modal.tsx" <<'TSX'
export function Modal({ onSave, onClose }: Props) {
  return (
    <div className="modal">
      <button
        onClick={() => {
          onSave();      // doesn't wait for anything
          onClose();     // closes right away
        }}
      >Save</button>
    </div>
  );
}
TSX
  cat > "$LAB/repo-b/src/useSaveProfile.ts" <<'TS'
export function useSaveProfile() {
  const [saving, setSaving] = useState(false);
  async function save(data: Profile) {
    setSaving(true);
    try {
      await api.post("/profile", data);   // takes ~600ms
      toast.success("Saved");
    } catch (e) {
      toast.error("Could not save");      // doesn't rethrow: the promise never rejects
    } finally {
      setSaving(false);
    }
  }
  return { save, saving };
}
TS
  (cd "$LAB/repo-a" && git init -q && git add -A && git commit -qm modal && git checkout -q -b feat/modal-save)
  (cd "$LAB/repo-b" && git init -q && git add -A && git commit -qm hook && git checkout -q -b feat/save-profile)
}

session() { # name, spoochie_home, dir
  mkdir -p "$3" "$LAB/$1"
  rm -f "$LAB/$1.fifo"; mkfifo "$LAB/$1.fifo"
  nohup sh -c "exec sleep 100000 > $LAB/$1.fifo" >/dev/null 2>&1 &
  sleep 0.3
  SPOOCHIE_HOME="$2" nohup sh -c "cd $3 && exec claude -p --verbose \
    --input-format stream-json --output-format stream-json \
    --settings '{\"crossSessionInbound\":\"accept\"}' \
    --dangerously-skip-permissions --name spoochie-$1 \
    < $LAB/$1.fifo > $LAB/$1.out 2> $LAB/$1.err" >/dev/null 2>&1 &
}

tell() { python3 -c 'import json,sys; print(json.dumps({"type":"user","message":{"role":"user","content":sys.argv[1]}}))' "$2" > "$LAB/$1.fifo"; }

case "${1:-}" in
  up)
    [ -n "$A_USER" ] && [ -n "$B_USER" ] || { echo "Missing SPOOCHIE_A_USER and SPOOCHIE_B_USER (Slack ids)"; exit 2; }
    "$0" down >/dev/null 2>&1 || true
    rm -rf "$LAB"; mkdir -p "$LAB"
    fixtures
    machine a "$LAB/home-a" "$A_USER" "Ana"
    machine b "$LAB/home-b" "$B_USER" "Edu"
    session a "$LAB/home-a" "$LAB/repo-a"
    session b "$LAB/home-b" "$LAB/repo-b"
    sleep 5
    for s in a b; do
      tell $s "Run this in bash and paste the output: echo \"{\\\"session_id\\\":\\\"sim-$s\\\",\\\"cwd\\\":\\\"\$PWD\\\"}\" | bun run $ROOT/src/cli.ts register && bun run $ROOT/src/cli.ts sessions"
    done
    echo "Machine A ($A_USER, Ana) and machine B ($B_USER, Edu) up in $LAB"
    ;;
  a|b) tell "$1" "$2" ;;
  out)
    python3 - "$LAB/${2}.out" <<'PY'
import json,sys
for line in reversed(open(sys.argv[1]).read().splitlines()):
    try: o = json.loads(line)
    except Exception: continue
    if o.get("type") == "result": print(o.get("result", "")); break
PY
    ;;
  down)
    pkill -f 'name spoochie-a' 2>/dev/null || true
    pkill -f 'name spoochie-b' 2>/dev/null || true
    pkill -f 'sleep 100000' 2>/dev/null || true
    for h in "$LAB/home-a" "$LAB/home-b"; do
      [ -f "$h/daemon.pid" ] && kill "$(cat "$h/daemon.pid")" 2>/dev/null || true
    done
    echo "lab stopped"
    ;;
  *) sed -n '2,16p' "$0" ;;
esac
