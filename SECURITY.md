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
- A key enters your contact list only through your own invitation: the invitation
  carries a one-time nonce, the newcomer's "hola" must return it, and the key is bound
  to the id and name you wrote down when inviting, never to what the hola claims. A
  "hola" over Slack must be signed with the ed25519 key already pinned for that Slack
  id. A contact that already has a key never gets it replaced by any hola; the attempt
  is logged as rejected. Before 0.9.8 none of this held: anyone with your npub and a
  teammate's Slack id could put their own key under that teammate's name.
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

## Advisories

- **0.9.8** (2026-09-07). Key exchange accepted unauthenticated "hola" messages: over
  Nostr from any key claiming a Slack id, over Slack from anyone holding the bot
  token. An attacker could bind their key to a contact's name and receive that
  contact's spoochies, end-to-end encrypted to the wrong person. Fixed as described
  above. If you ran 0.9.0 to 0.9.7, run `spoochie doctor`: it lists each contact's key,
  and `spoochie contacts` shows when it was set; if in doubt, `spoochie contacts
  --olvidar-clave <name>` and invite them again.
- **0.9.7** (2026-09-07). Invitations carried the Slack bot token in decodable base64.
  Rotate the token in the Slack app if an old invitation may have reached anyone
  outside the team.

## What CI checks on every push

- The test suite on Linux and macOS, including two real daemons talking over a
  directory that stands in for the relays.
- `scripts/fugas.ts`: no real Slack ids, tokens, private keys, 64-hex keys, or emails
  outside a short domain list, in the tree, in commit messages, or as author/committer.
  Plus a private word list (a repository secret) that this file will not reproduce.
- GitHub secret scanning with push protection is on for the repository.
