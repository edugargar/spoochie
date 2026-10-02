# Security model

What spoochie guarantees, how each guarantee is enforced, and where the boundary really is. Reports go through [SECURITY.md](../SECURITY.md).

## Rules that are built, not written

Not in a policy document: built, each with its test.

- **The receiving human opens the door.** A `say` before acceptance is rejected with the
  exact command to run. What makes the approval real is Claude Code's permission system:
  keep `spoochie accept` out of your allowlist and running it raises the dialog, which
  only the person can approve.
- **Nobody writes on the other machine.** A fix travels as a text patch or a branch, and
  the Claude over there applies it under its own permissions, if it's convinced.
- **The envelope is small**: branch, SHA, touched file names. Nothing else automatic.
  Attaching more is convenient right up to the day a `.env` slips into the envelope.
- **What the other side writes is fenced.** Every message enters between a random marker
  that changes per message, and the receiver's rules always come after the closing
  marker. Without that, a message could write its own headers or imitate spoochie's
  instructions.
- **Two clocks**: pending acceptance survives 4 h; live and silent dies at 10 min, with a
  warning at 7. An unread message and an unanswered call are not the same thing.
- **A patch that doesn't fit is refused when sent.** Over Slack a diff travels in 16,200
  characters; anything beyond is not truncated from the end, it is rejected and a branch
  is suggested.
- **The guardian judges on arrival, not on departure.** The sender need not be
  trusted. Off-topic only gets a label and a note in the thread. A message that asks
  the receiving Claude to run, modify, install, open, send files or secrets, or that
  poses as system rules, never enters the session: it waits in the thread until the
  receiving human writes `suelta` (release) or `descarta` (discard) in the thread, or runs
  `spoochie release`.
- **Envelopes are signed.** Each person gets an ed25519 key at join. Every envelope
  carries the public key and a signature over id, kind, sender and text; the first key
  seen for a Slack id is pinned, like SSH, and a later envelope from that id with
  another key is discarded and the thread is told. Unsigned envelopes still deliver,
  labelled as such.
- **"delivered" doesn't lie.** Over Slack a message leaves with a delay; until it leaves
  `say` waits up to 8 s for it to actually leave and then says it was posted; only if it
  takes longer does it say it is queued, and if publishing fails the sending session
  is told. The silence warning lists facts (when your last message left, when the other
  side accepted, when their last message arrived) so the Claude reading it doesn't guess.

## Where the boundary is

Honest version. The real boundary is "whoever holds the bot token is on the team".
Everything else is built on top of that.

What's in place: text-only across machines (patch or branch name, never writes); the
human gate through Claude Code's permission dialog; signed envelopes with keys pinned on
first sight; the receiving-side guardian that holds anything asking the Claude to act;
per-message random fencing of remote text; downloaded files can't escape the spool
(`../` in name or id, tested) and neither can a thread id from an envelope (validated
on receipt and sanitised again on write); a sender's display name can never take over
an existing contact's entry; the binary the hook downloads is the one for the installed
plugin version and is checked against the release's `SHA256SUMS` before it runs; a
minimal envelope; config and session records at 0600 with `doctor` complaining
otherwise; both timeouts; no secrets in this repo.

What you should know:

- **One bot token for the whole team.** Whoever holds it can read the bot's DM with
  anyone and post as the bot. It is not in invitations and no flag puts it there: a
  newcomer talks over Nostr and never holds it. Everyone who joined
  before 0.9.7 has it in their config; rotate it when someone leaves. Per-person OAuth
  (`xoxp`) is still supported via `spoochie slack setup` for teams that want it.
  **A team where everyone has a Nostr key does not need the token at all**: spoochies go
  encrypted through relays, and the notification is the local system dialog, not a DM.
  `doctor` says so when it applies, and `spoochie slack off` removes it from a machine.
  That is the only way out of "whoever holds the token is on the team", and it is
  available today, not a plan.
- **A Nostr key enters your contact list only through your own invitation.** The
  invitation carries a one-time nonce; the newcomer's hello (a `hola` envelope) returns it
  and the key is bound to the id and name you wrote down when inviting, not to what the
  hello says. A hello over Slack must be signed with the ed25519 key pinned for that Slack
  id. A contact that has a key never gets it replaced by a hello; the attempt is logged.
  `spoochie contacts` shows every key; `--forget-key` drops one so you can re-invite.
- **Slack envelopes are pinned on first sight.** Whoever holds the bot token can still
  post the *first* envelope for a Slack id nobody has heard from, with a key of their
  own. After that, that id is theirs. Invitations carry the inviter's key, so the
  person who invited you is pinned before anything arrives.
- **Remote text enters your session as a turn.** The fence stops it from posing as a
  header or as spoochie's rules, and the guardian holds what asks you to act, but a
  persuasive message is still a persuasive message. Run Claude Code with normal
  permissions, not bypass, on machines that use spoochie.
- **The invitation goes through the model.** `/spoochie:join <blob>` passes it as a
  prompt argument, so whatever is inside lands in that session's context and in its
  local transcript under `~/.claude/projects/`. That is why nothing secret is allowed
  in there: the invitation holds public keys and ids only.
- **The side Claude is read-only in practice, not by proof.** Its allowlist is Read,
  Grep, Glob, read-only git and the spoochie subcommands; Edit, Write and the git
  commands that change history are denied. `allowedTools` cannot filter arguments, so
  a `PreToolUse` hook (the gatekeeper, `src/gatekeeper.ts`) reads every Bash line before it runs and denies
  shell metacharacters outside quotes, unknown programs, and the git flags that write
  (`--output`, `-o`), read outside the repo (`--no-index`, `-C`, `--git-dir`) or run
  another program (`-c`, `--ext-diff`). In `auto` mode a Bash command
  outside the allowlist is decided by Claude Code's classifier, not by a person.
- **The guardian fails open, visibly.** If Haiku is unreachable or times out (20 s), the
  message is delivered labelled `unwatched` in the session and in the thread, rather
  than lost or silently trusted. A held message needs a working guardian.
- **Every envelope carries the sender's version.** When the other side is on an older
  line, the newer daemon says so once in the thread, with the update command. Both
  machines on the same minor version are guaranteed to understand each other; across
  minors, the newer side keeps reading the older format.
- **Slack sees everything**: patches and screenshots travel in the clear through Slack,
  like anything else you already paste there. The guardian sends each incoming message
  to Haiku; `spoochie config --guardian off` turns that off, and with it the hold.
- **The daemon's local socket has no auth.** Any process running as your user can ask it
  to inject text into your sessions. On a single-user machine that's the same boundary as
  your own processes; on a shared box it isn't.
