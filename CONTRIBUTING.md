# Contributing

## Setup

```sh
git clone git@github.com:edugargar/spoochie.git && cd spoochie
bun install --frozen-lockfile
git config core.hooksPath .githooks   # leak check before every push
bun test
```

Tests isolate all state under a temporary `SPOOCHIE_HOME`; they never touch your real
`~/.claude/spoochie`. Two suites start real daemons (`tests/dos-maquinas*.test.ts`) and
take a few seconds.

## Before anything is pushed: a real conversation

```sh
bun scripts/real-test.ts
```

Green tests are not proof that two people can talk. They use fake inboxes, relays in a
directory and a fake `claude`, and on 2026-10-01 they were green while the first real
spoochie failed end to end: the accept click arrived empty and the daemon could not find
`claude`. The real test uses none of that. Two empty `SPOOCHIE_HOME`s, each daemon started
with the exact environment its LaunchAgent would give it, public Nostr relays, two real
Claude sessions in Terminal windows, the join through `/spoochie:join`, a real mouse click
on the notice, and a question whose answer only exists in the other person's repo. It
passes only if that answer reaches the first person's Claude. It takes a few minutes and
uses the screen, and leaves three screenshots.

On success it writes a seal for the tree of `HEAD` under `.git/spoochie-real-test/`. The
pre-push hook refuses any commit or tag whose tree has no seal, and a dirty tree gets no
seal. The seal is per tree, not per commit, because a rebase merge on GitHub rewrites the
commit and keeps the files, and the files are what was tested.

## How changes land

`main` is protected: no force pushes, no deletions, linear history, and every commit
must arrive through a pull request whose checks (tests on Linux and macOS, leak check)
are green. That applies to the maintainer too.

- One mechanism per commit, with the before and after in the message. A fix says what
  was observed, what was expected, and what changed. "Fix bug" is not a message.
- A test for every behaviour that a person could notice. A red test is a question, not
  a verdict: read the assertion and say which of the two is wrong before touching it.
- Nothing that identifies a person or a company that is not this project: no teammate
  names, no employer, no Slack ids, no internal app names. The leak check enforces the
  generic part; the private word list enforces the rest.
- Write in the same register as the code around you. Comments explain why, not what.

## Versions

Versions follow `MAJOR.MINOR.PATCH`. Before 1.0, MINOR can change the protocol between
daemons; the envelope carries the sender's version and `doctor` tells both sides when
they differ. PATCH is bug fixes only.

The 0.9 line is frozen for features until a spoochie with an attached file has been
exchanged between two different machines over Nostr, by two different people, with
screenshots. Until then, only fixes go in.

## Releasing

```sh
bun scripts/version.ts X.Y.Z "One line for the CHANGELOG"
# edit CHANGELOG.md if the line needs company; commit on a branch, open the PR, merge it.
git checkout main && git pull --ff-only
git tag vX.Y.Z && git push origin vX.Y.Z
```

The version bump goes through a pull request like everything else; the tag is created
on the merged commit and pushed on its own. Creating a `v*` tag is allowed; moving or
deleting one is not.

The tag triggers the release workflow: it builds four binaries with `bun build
--compile`, writes `SHA256SUMS`, and attaches them to the GitHub release. The session
hook on every machine downloads `spoochie-<version>` for its platform and refuses it if
the checksum does not match. Tags are protected: a released version is never rebuilt
under the same tag.
