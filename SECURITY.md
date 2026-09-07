# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/edugargar/spoochie/security/advisories/new)
on GitHub. Do not open a public issue for anything that could be exploited. You will get
an answer within a week; a fix for a confirmed problem ships as a patch release with a
CHANGELOG entry that credits you unless you ask otherwise.

## Supported versions

Only the latest release gets fixes. Every daemon checks the latest release once a day
and `spoochie doctor` says when you are behind. Envelopes carry the sender's version, so
a peer on an old version is visible on both sides.

## What the threat model covers

The README section "Security model" says what is checked and what is only true in
practice. In short:

- Between machines, the conversation is end-to-end encrypted (NIP-44) inside a gift
  wrap (NIP-59) signed by a one-time key. Relays see a recipient key and a fake date.
- Only contacts with a known key can reach you. An envelope from an unknown key is
  dropped without being opened further.
- On close, each side asks the relays to delete what it published and deletes locally.
- Keys and tokens live in `~/.claude/spoochie/config.json` with mode 0600, in a
  directory with mode 0700. They are not in a keychain.
- An invitation is base64 JSON that anyone can decode. It carries public keys, a Slack
  id and a name; no token unless the inviter passes `--con-slack`, and then the DM says
  so. Before 0.9.7 every invitation carried the Slack bot token: if one of those was
  pasted somewhere public, rotate the token in the Slack app.
- The side Claude runs in a fresh git worktree with a read-only tool allowlist. It
  cannot write to your checkout; it can read it, including files you would not share.
- Binaries are built by GitHub Actions from a tag and verified by SHA256 before they
  run. The hook refuses a binary whose checksum does not match.

What it does not cover: a compromised relay can drop or delay messages (not read them);
a compromised machine on either side has everything; the Slack path (for contacts
without a Nostr key) trusts Slack.

## What CI checks on every push

- The test suite on Linux and macOS, including two real daemons talking over a
  directory that stands in for the relays.
- `scripts/fugas.ts`: no real Slack ids, tokens, private keys, 64-hex keys, or emails
  outside a short domain list, in the tree, in commit messages, or as author/committer.
  Plus a private word list (a repository secret) that this file will not reproduce.
- GitHub secret scanning with push protection is on for the repository.
