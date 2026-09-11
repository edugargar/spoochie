# Changelog

## 0.9.9 (2026-09-10)

- The README now states three promises (no server of ours, the model is yours, closing deletes it) with the test that proves each one next to it, and a test that fails if the README points at a file that no longer exists. A claim without a check is marketing.
- `spoochie llavero on` moves the three secrets (your ed25519 signing key, your Nostr secret key and the team bot token) from `config.json` into the macOS keychain, leaving `"@llavero"` in their place. `off` brings them back. It is manual and reversible on purpose: an automatic migration of someone's keys, if it goes wrong, locks them out of their own contacts. `doctor` says which ones are still in the clear.
- Contacts can now carry a trust level and standing consent, both off by default. `spoochie contacts --nivel <name> alto` stops off-topic labels for that person (noise, when you already know who you are talking to). `spoochie confiar @sam --repo <repo>` lets their spoochies about that repo in without the dialog, and says so in the thread each time it happens. Both are per person, and consent is also per repo: "I trust Sam" on its own would be a master key to every machine you work on. Neither ever opens the guardian's hold on a message that asks the assistant to act, because the sender's account is exactly what is worth stealing.
- Fixed: a daemon that was slow to die deleted the socket and lock file of the daemon that had just replaced it, leaving a running daemon nobody could reach (the CLI got ENOENT on a file that existed a moment earlier). It now only cleans up if the lock still holds its own pid. Found by the new restart test.
- Security: if the guardian does not answer, the message is now held instead of delivered with a "sin vigilar" label. It retries once first. Measured with the new corpus (24 cases, one pass): 23 correct, 0 escaped, and 1 case with no answer within the timeout, which was the one asking for `~/.aws/credentials`. That is not a coincidence: an ambiguous or adversarial message is the one that makes the model think longest, so the timeout runs out on the dangerous ones first.
- Tests: a versioned corpus of 24 guardian cases (`tests/corpus-vigilante.json`), run against the real model with `bun scripts/vigilante.ts`. Plus duplicate-envelope, out-of-order and daemon-restart tests.
- Tests: a real Nostr relay now runs inside the test process (NIP-01: EVENT, REQ with filters, EOSE, CLOSE, OK), and it can be killed on purpose. Every test used to go through the file-based pool, so `poolReal` (SimplePool over WebSocket), the only transport that runs outside the tests, had no coverage at all. Five new tests: an envelope crosses a real relay encrypted and reaches only its recipient, what was published while nobody listened arrives on subscribe, the relay answers EOSE, a raw SimplePool subscription does not survive a relay restart, and `NostrBridge` does because it resubscribes.
- Security: the daemon and the background side Claude no longer inherit the whole environment of whoever started them. The CLI runs inside a Claude Code session, so it was handing the daemon that session's `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` (the keys to the inbox you are working in), and the daemon passed them on to the side Claude. Now both get an explicit list. Window mode already did this through its script.
- Security: a key is pinned only for a Slack id that is already in your contacts, meaning someone you invited or who invited you. `verificarSobre`, which every envelope goes through, used to add the sender to your contacts under whatever name they claimed, just for having posted once. 0.9.8 wrote that rule for the "hola" path only; now it lives where all the traffic passes.
- Security: an unsigned envelope from a sender whose key you already have pinned is now dropped, not delivered with a label. Tolerating it made the signature decorative, because the way to attack was simply not to sign. An unsigned envelope from someone you have no key for is still delivered and labelled: that one really can be an old version.
- Fixed, and the worst of the lot because it needs no attacker: a process killed halfway through a write left `config.json` truncated, and `load` then returned the defaults without a word. Measured with the file cut in half: signing key gone, Nostr key gone, bot token gone, address book empty, and the next `save` wrote that over the remains. The daemon saves the config on every incoming message. State files are now written beside themselves and renamed, which is atomic on one disk, so a reader sees the old file whole or the new one whole. The config also keeps a copy of the previous version and reads it when the current one makes no sense; if neither parses it says so and refuses to write, because turning "I cannot read it" into "it does not exist" is how you lose it for good. Threads, the outbox, both seen-lists and the session registry had the same `writeFileSync`.
- Security: a flood of spoochies turned the accept button into the escape hatch. Measured with twenty-five envelopes in a row from one contact: twenty-five threads on disk and twenty-five notification windows at once, all floating in the middle of the screen and all stealing focus. The quick way out of a stack of modal windows is to hammer Return, and Return on that window is "Que pase". Notifications are now queued one at a time, and one person can hold at most five unanswered spoochies, which is per person rather than global and drains itself through the four-hour timeout.
- Security: the other side can no longer write in the thread with spoochie's own voice. A patch is rendered inside a code fence, and a patch containing one closed it: everything after was rendered as ordinary markup, including lines identical to spoochie's own ":lock: closed" and ":white_check_mark: has accepted". The Slack thread is where a *person* looks to see what happened, so it is the one surface that cannot be written by the person at the other end.
- Security: what the notification says is who is calling, and that name was not signed. `fromName` rides outside the signature, so an envelope correctly signed by one person could be displayed under another's name, and that name is the only thing someone has to go on when deciding whether to accept. It now comes from your own address book; the envelope's name is the last resort. The subject and the context (branch, sha, file names) are not signed either and are not taken at face value any more: one line and a size each, and the file names in particular, because they are printed straight into the side Claude's first turn. Same for a close reason arriving from the other machine, which is said inside the receiving session and never passes the guardian, since a close is a notice.
- Security: the transcript URL must be an Artifact URL. `spoochie transcript --url` stored whatever it was given and the daemon posted it into the other person's thread; the side Claude has `spoochie transcript` on its allowlist and the gatekeeper does not inspect that flag, because `--url` opens no file, it carries the data inside it. That was data leaving a machine whose Claude is read-only, the same shape as the Artifact hole.
- Security: a version 1 signature no longer accepts an `accept` or a `close`. It covers neither the timestamp nor the recipient, so one stays valid forever and in any thread, and it costs no compatibility: 0.9.8 signed only invitations and messages.
- Fixed: the LaunchAgent plist is XML, and paths went into it unescaped. A directory containing `&` made it invalid (`plutil -lint`: "Encountered unknown ampersand-escape sequence"); launchd refused it, `launchctl` failed silently because the `||` swallowed both attempts, and the installer still reported "installed". The symptom was "nothing arrives", which is the exact thing that file exists to prevent. The PATH baked into the agent is also no longer the whole PATH of whichever shell ran `register` once, since a temporary `bin` in it would be used on every boot of the machine, forever.
- Security: the guardian now reads the whole message and every kind of turn. It was given `text.slice(0, 4000)` while a message can be 25,000 characters, so 21,000 characters of each one went unread while the session received all of it: pad with four thousand characters and put anything you like behind them. Anything longer than it can judge is now held, because a message that cannot be judged is not a judged message. It also skipped every turn that was not plain text, so the sender chose whether to be watched by typing `spoochie patch` instead of `spoochie say` — and the guardian exists precisely because the sender need not be trustworthy. `kindOfMsg`, the word that decided that, travelled outside the signature and now rides inside it.
- Security: the state directory is set back to 0700 on every start. `mkdirSync`'s mode only applies when the directory is created, so one that already existed open stayed open, with the config holding all three secrets, the daemon socket, the threads and the file spool inside it. `doctor` reported it, but doctor is what you run once something is already broken.
- Security: Nostr file chunks are capped at the chunk size before being decoded. `total` and `size` are declared by the sender and were checked, but the bytes that actually arrived were not: measured, a single envelope with `total: 1` wrote 3 MB to disk with a 20 KB chunk size. The real limit was whatever the relay accepted, which is no limit when the relay belongs to the sender. Files parked in the spool for a thread that never materialises are also swept after four hours; nothing removed them before, and they landed on disk before anyone had been asked anything.
- Fixed: the one-time invitation nonce was dropped when reading an invitation, so `join` sent its hello without it and the inviting side rejected the newcomer's key as "no valid invitation and unknown key". Signing up over Nostr did not work and the key had to be added by hand with `--npub`, which is the fallback path. The nonce had its own tests and the invitation string had its own; the seam between them had none. What travels in that string now also has a shape and a size: the name is capped (it ends up in the address book and in the notification's title) and the ed25519 key is only pinned if it looks like one.
- Security: an `accept` or a `close` that arrives over Slack without a valid signature no longer opens or closes anyone's tunnel. Those two envelopes act on their own (one opens the tunnel and starts the side Claude, the other closes the spoochie and purges what it stored), and they were handled before the signature was ever checked, which only messages went through. Both sides post with the same bot token, so anyone holding it could open or close tunnels as someone else, which is exactly the attacker the signature exists for. They are also signed on the way out now. This breaks accept and close with machines older than 0.9.9, which send them unsigned; it is said in the thread when it happens, and the fallbacks (accepting in the notification or in the thread, and the 10-minute silence timeout) are unchanged.
- Security: the *portero* hook was registered with `matcher: "Bash"`, and a PreToolUse matcher is a regular expression against the tool name. So the portero only ever saw Bash calls: its whole confinement of `Read`, `Grep` and `Glob` to the worktree was written, had green tests of its own, and never ran. The side Claude could read `~/.ssh` and report it through the tunnel, which is the thing that code exists to prevent.
- Security: the portero now also judges `Artifact`, the only tool the side Claude has that sends content off the machine. It is on its allowlist for one narrow reason (publishing the transcript, which the daemon cannot do and the interactive session must not see); with any other `file_path` it published whatever the side Claude could read, which is the whole repo including its `.env`. A parity test compares the list of tools the hook fires for against the list the portero judges.
- Fixed: over Nostr, an envelope carrying a protocol version other than 1 was dropped before anything could say so, and so was one with no version at all. The rule written in `protocolo.ts` and published in `docs/PROTOCOLO.md` says a higher version is not delivered but is announced in the thread with the sender's app version, and that a missing version predates the field and counts as 1. Slack did that; Nostr, the default transport, did neither, and the sender saw it as delivered.
- Security: file downloads only send the bot token to `slack.com` or `slack-files.com` over TLS, and the thread id is sanitised where it is used to build a path. Neither was reachable, since both values come from validated places today; the point is that the function no longer depends on nobody calling it wrong.
- The incoming-spoochie notification is now a real native window instead of an AppleScript box. `display dialog` paints one type size and one colour, so who is calling, the subject and what they said all read the same. The window sets who calls at 19 pt semibold, the subject in secondary colour, the quote against an accent rule, the branch in monospace because it is code, and the whole thing on the same glass the system menus use. `NSAlert` was built and rejected with the reasoning written into `ventana.ts`: `runModal` from osascript returns 1000 immediately without waiting for anyone, so the window flashes and the program reports a button nobody pressed. `display dialog` stays as the fallback. The screenshot script no longer captures the whole screen for the notification: the window can be placed where asked and reports its height, so `screencapture -R` crops exactly its rectangle.
- The incoming-spoochie dialog was redesigned. It used to open with one of five rotating jokes, then two labelled lines ("Asunto:", "Rama:"), then a three-sentence closing paragraph: five lines of decoration around two of information, and the first thing you read was not who was calling. Now: who calls, what they want, what they said, and what happens if you open. No labels. The character is carried by the icon and by the "Que pase" button. The logo lost its white background, so it sits on the dark box instead of in a white square. The Slack thread header uses the same voice ("Sam llama").
- Security: envelope signatures now cover the recipient, the timestamp, the version, the subject and the thread they point at, not just id, kind, sender and the message text. Before, a correctly signed envelope stayed valid if someone forwarded it to another person's thread or re-posted it months later, and the subject, the thread pointer and the version travelled outside the signature. A stale envelope (more than 24 h either way) or one addressed to someone else is now dropped and said so in the thread. Signatures from 0.9.8 and earlier still verify, labelled as old.
- Security: `spoochie invite --con-slack` is gone. It was the one remaining way to put the Slack bot token, a credential for the whole team, inside a base64 string sent over a DM. A newcomer does not need it: their daemon talks over Nostr and the notification DM comes from the opener's bot. The cost is that a newcomer can no longer reach a contact still on the pre-0.9 Slack transport; that contact updates instead. `join` reads a pre-0.9.9 invitation that still carries a token, drops the token, and says it must be rotated.
- Security: the side Claude's Bash calls now go through a `PreToolUse` hook (the *portero*) that reads the actual command line. `--allowedTools` matches by prefix and cannot filter arguments, so `Bash(git diff:*)` let through `git diff --output=<file>` (writes), `git diff --no-index /etc/passwd` (reads outside the repo), `git -c core.pager=id log` (runs a program) and anything after a `;` or `&&`. Measured before the change: five of six such shapes passed. The scanner respects quotes, so a `;` inside a message body is still just text.
- The side Claude launches with the same flags in a window and in the background. They had drifted: the window used `auto`, the background had `default` hardcoded, which is the mode that cannot ask anyone.

## 0.9.8 (2026-09-07)

- Security: a Nostr key enters your contacts only with the one-time nonce of your own invitation, bound to what you wrote when inviting; a hola over Slack must be signed with the pinned ed25519 key; an existing key is never replaced by a hola. Before, anyone with your npub and a teammate's Slack id could put their own key under that teammate's name. `spoochie contacts` lists keys and `--olvidar-clave` drops one.

## 0.9.7 (2026-09-07)

- Invitations no longer carry the Slack bot token (anyone can decode the base64; a teammate did on day one). `--con-slack` puts it back for reaching pre-0.9 contacts. A closed Nostr bridge no longer resubscribes itself five seconds later next to the new one, which delivered every envelope twice after a config reload.

## 0.9.6 (2026-09-06)

- The Nostr key DM over Slack goes at most once a day per contact and is remembered across restarts; it went out on every daemon start (two DMs to the same person in 35 s).

## 0.9.5 (2026-09-06)

- An envelope or a Slack message that arrives after a spoochie is closed is dropped instead of refilling the purged thread; file chunks for a closed spoochie do not touch the spool (seen as a race in CI).

## 0.9.4 (2026-09-06)

- The release workflow refuses a tag whose version is not the one in `plugin.json`. There is no 0.9.3: its tag was cut on the wrong commit, tags are immutable, and the release run was cancelled before it produced anything.
- Upgrading no longer leaves the old daemon running: a daemon started by a hook is not known to launchd, so the new one died with "already running" every 10 s while the old version kept serving. The hook now shuts the stale daemon down and starts the new one, also when the plist was already current.

## 0.9.2 (2026-09-05)

- Files travel over Nostr: 20 KB encrypted chunks, reassembled in the receiver's spool and announced with the local path, as over Slack. Chunks arriving before the invitation wait for it.

## 0.9.1 (2026-09-05)

- The heartbeat carries the daemon's version and `doctor` warns when the running daemon is older than the plugin (it happened: doctor said 0.9.0 with a 0.7.1 daemon under launchd).

## 0.9.0 (2026-09-05)

- Conversations between machines travel over Nostr by default: NIP-17 private messages (NIP-44 encryption, NIP-59 gift wrap) through public relays, no server of ours, keys in your config. Only contacts with a known key can reach you.
- On close, each side asks the relays to delete what it published (NIP-09) and deletes locally.
- Slack becomes the notifier (one DM line when someone opens a spoochie with you) and the key-exchange channel: existing Slack contacts swap Nostr keys automatically, nothing to re-join. `spoochie config --transporte slack` keeps threads in Slack.
- `spoochie nostr` shows your key and relays; `--relays` sets them. `spoochie invite` works without Slack (prints a Nostr-only invitation). `doctor` shows the key and which contacts still lack one.
- Files are not carried over Nostr yet.

## 0.8.2 (2026-09-05)

- A spoochie is deleted when it closes (local, files, transcript, and everything the bot posted in Slack); the close now reaches the other machine as its own envelope kind.

## 0.8.1 (2026-09-05)

- Origin configurable in one place (marketplace.json origin, SPOOCHIE_ORIGEN); docs/for-your-company.md.

## 0.8.0 (2026-09-04)

- Outgoing messages are queued on disk and resumed after a daemon restart; failed publishes retry every minute. Side windows are re-attached after a restart.
- The Claude on the side works on a clean `git worktree` copy of the repo, never on your checkout (`spoochie config --copia off` to change that).
- Every envelope carries the sender's version; the newer side says once in the thread when the other is behind. `spoochie --version`.
- A message the guardian could not judge is delivered labelled `sin vigilar`, in the session and in the thread.
- The daemon checks the latest release every 6 hours and mentions a newer one; `doctor` shows version, side-Claude mode and the outbox.
- Our own mascot (docs/spoochie.svg) instead of Poochie's picture.
- `CHANGELOG.md`, one version source (`bun scripts/version.ts`), tests on every push on Linux and macOS, and the Slack app as a manifest (`docs/slack-app-manifest.yml`).

## 0.7.1 (2026-09-04)

- The thread of a spoochie you open lives in a group DM (bot + both people). `--hilos canal|dm` for the alternatives. Needs `mpim:*` scopes; falls back to the receiver's DM without them.
- Transcript Artifact documented as off by default.

## 0.7.0 (2026-09-04)

- An incoming spoochie is a macOS dialog (with the mascot), not a turn in the terminal you work in. "Que pase" opens the side window; "Ahora no" rejects; "Ver en Slack" opens the thread.

## 0.6.4 (2026-09-04)

- `say` waits up to 8 s for the real Slack publish and says `publicado`; the silence notice lists facts instead of letting the Claude guess.

## 0.6.3 (2026-09-04)

- The Claude on the side publishes the transcript of incoming spoochies (when the transcript is on).

## 0.6.2 (2026-09-04)

- The side window runs in `auto` permission mode with a deny list (Edit, Write, git push/commit/checkout/reset, rm) and knows about rtk-rewritten commands.

## 0.6.1 (2026-09-04)

- `/spoochie:join` no longer asks for Bun.

## 0.6.0 (2026-09-04)

- Renamed to Spoochie everywhere. State moves from `~/.claude/spochie` on first start; the old launchd agent is removed.

## 0.5.4 (2026-09-02)

- Security audit fixes: envelope thread ids validated, contact names can't take over another id, the downloaded binary is the plugin's version and is verified against `SHA256SUMS`, `git branch` limited to `--list`.

## 0.5.3 (2026-09-02)

- The inbox poll adapts to the team size, 5 s floor.

## 0.5.2 (2026-09-02)

- The invitation goes to one session with the question in it; the Claude on the side opens in a new terminal window; interactive sessions see nothing more.
