# Usage

Everything a person or their Claude runs. In practice you talk to your Claude in plain words and it runs these for you.

## Joining a team

One command on the inviter's side, and on the newcomer's side two commands in Claude
Code, a restart, and one paste. No terminal, no Slack login, no tokens to copy, no Slack
permissions to ask for, nothing to install first: if [Bun](https://bun.sh) isn't there,
the first session start fetches a self-contained binary from this repo's releases.

The inviter runs:

```
spoochie invite --to sam@example.com          # or --to U01234567 --name Sam
```

The bot sends the newcomer a DM with everything inside: the two plugin commands, the
restart, and the line to paste. That line already says who it's for and who sent it, so
the newcomer never has to be looked up in Slack and `@edu` resolves locally afterwards.

The newcomer follows the DM:

```
/plugin marketplace add edugargar/spoochie
/plugin install spoochie@edugargar
```

restarts Claude Code, and pastes the last line of the DM:

```
/spoochie:join eyJiIjoi...
```

Pasting the whole DM works too; the invitation cleans itself out of whatever surrounds
it. At the end it runs `spoochie selftest` and prints `All good` or which step failed.

`spoochie invite` with no `--to` prints the line for you to send by hand.

What the invitation carries: the inviter's public keys and relays, the newcomer's Slack
id and name, and the team name. It is base64 JSON, not encrypted, and anyone can open
it, so there is no secret inside, and there is no flag that puts one there. The
newcomer's daemon talks over Nostr, and the DM that tells them someone opened a
spoochie comes from the opener's bot. Until 0.9.8 `--con-slack` put the bot token back
in the string for a newcomer who had to reach contacts still on the Slack transport
(pre-0.9); that flag is gone. Handing a team-wide credential to a newcomer over a DM
so they can talk to someone who has not updated is the wrong trade: those contacts
update instead. A pre-0.9.9 invitation that still carries a token is read, the token is
dropped, and `join` tells the newcomer to have it rotated.

## Commands

In practice there's nothing to learn: tell your Claude in plain words, "open a spoochie
with Bob about the modal save error". Underneath it runs this:

```
spoochie sessions
spoochie open <target> --subject "the button breaks" --body "..." [--files a,b]
    target: a local session name, or @person for another machine
spoochie accept <id>                  RUN BY THE RECEIVING HUMAN
spoochie say <id> "<text>" [--human] [--files a,b]
spoochie patch <id> [--from-git | --diff-file f]
spoochie branch <id> <branch>
spoochie close <id> --reason "..."
spoochie list | show <id> | transcript <id>
spoochie search "<text>"              across every spoochie on this machine
spoochie config --human "Alice" --guardian on|off --transcript on|off --threads group|channel|dm [--channel C0…]
```

When someone opens one for you, you get a DM from the bot. Replying in that thread is
accepting. Until you accept, not a single answer leaves your side.

## Checking it works

```
spoochie selftest     walks the whole loop here, needing nobody and never touching Slack
spoochie doctor       reviews what has to be right in order to deliver
```

`selftest` spins up two fake inboxes and goes through the same stops as a real spoochie:
the approval gate, the round trip, the close. A step that depends on a broken one is
marked untested, never passed.

`doctor` exists because this tool's failures are silent by nature: an expired token, a
file with loose permissions or a dead daemon don't error, they just make the message not
arrive and nobody notices.

## Coming from `spochie` (0.5.x)

Same tool, one letter longer. Uninstall the old
plugin first, then install the new one: `/plugin uninstall spochie@edugargar`,
`/plugin marketplace update edugargar`, `/plugin install spoochie@edugargar`, and
restart Claude Code. Your state (token, keys, contacts, threads) moves itself from
`~/.claude/spochie` to `~/.claude/spoochie` on first start, and the old launchd daemon
is stopped and removed. The old GitHub URL redirects. Nothing to re-join.
