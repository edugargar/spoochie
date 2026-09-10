# The spoochie envelope

This is what travels between two machines. It is written down so something other than
Claude Code can speak it, and so that a change to it is a change to a document and not
just to a struct.

Protocol version: **1** (`src/protocolo.ts`). Everything below is version 1.

## The rule about versions, first

An envelope carries `v`. A receiver that sees a `v` **higher** than its own does not
deliver the message: it says so in the thread, names the sender's app version, and tells
the person to update. It does not try to interpret it.

That is deliberate. A newer envelope may carry a field that *narrows* what the message
is allowed to do; a receiver that ignored it would deliver the text without the part
that fences it. An envelope with no `v` predates the field and is treated as 1.

Since spoochie ships as a binary pinned to a plugin version, two machines on different
versions is the normal case for weeks after a release, not an edge case.

This holds on both transports. It did not: over Nostr the envelope was dropped before
anything could say so, which is worse than either branch of the rule, because the sender
sees it delivered.

## Shape

```jsonc
{
  "v": 1,                       // protocol version
  "id": "k7f",                  // thread id; [A-Za-z0-9_-], validated on receipt
  "kind": "invite",             // invite | msg | accept | close | notice | hola | rota | file
  "from": "U0EDU001",           // sender: Slack user id, or "nostr:<pubkey>"
  "to": "U0SAM001",             // recipient; empty on a "hola"
  "ts": 1789012345,             // seconds since epoch, set by the signer
  "sv": 2,                      // signature version
  "app": "0.9.9",               // sender's spoochie version
  "subject": "the modal breaks",
  "fromName": "Edu",
  "kindOfMsg": "text",          // text | patch | branch
  "context": { "branch": "fix/modal", "sha": "…", "files": ["src/modal.tsx"] },
  "thread": { "channel": "C0…", "ts": "1789012345.000100" },
  "pk": "<base64 SPKI ed25519 public key>",
  "sig": "<base64 signature>"
}
```

The message **text** is not in the envelope. On Slack it is the message body; on Nostr it
is the sealed rumor's `content`. The envelope is metadata plus a signature over both.

## The signature

Signature version 2 (spoochie 0.9.9 and later). Ed25519 over these bytes:

```
JSON.stringify([
  2,
  id,
  kind,
  from,
  to ?? "",
  ts ?? 0,
  app ?? "",
  subject ?? "",
  thread ? `${thread.channel}/${thread.ts}` : "",
  sha256(canon(text)),        // hex
])
```

A fixed order, every field present even when empty, so two different envelopes cannot
produce the same bytes. `canon()` (`src/firma.ts`) undoes what Slack does to text in
transit: CRLF to LF, `&amp;`/`&lt;`/`&gt;` back to characters, `<url|label>` to `label`,
trimmed. Without that, a signature made before posting would not verify after.

Version 1 signed only `id`, `kind`, `from` and the text hash. It still verifies, and is
labelled as old. Do not produce it.

### Two kinds act on their own

`accept` opens the tunnel and starts the side Claude. `close` closes the spoochie and
purges what it stored. Nobody reads them; they just happen. So for those two, "not
rejected" is not enough: they need a signature that verifies. An unsigned envelope from
an id with no pinned key is still delivered **as a message**, labelled unsigned, because
a person reads it and sees the label. As an `accept` or a `close` it is dropped and said
in the thread.

That breaks accept and close over Slack with machines older than 0.9.9, which send them
unsigned. The fallbacks are unchanged: accept in the notification or by writing in the
thread, and a tunnel dies on its own after 10 minutes of silence.

`notice` carries no signature. It does nothing on arrival, and signing it would mean
signing the ones the *receiver* posts into the thread ("is looking at their code"), which
have no owner there.

### What a receiver checks, in order

1. `v` is understood (above), or the message is not delivered.
2. `sig` and `pk` present. **Absent, and the sender's key is already pinned: rejected.**
   Absent from an id with no pinned key: delivered, labelled unsigned.
3. The signature verifies over the bytes above.
4. `ts` is within **24 hours** either way. Outside: rejected as stale. A correctly signed
   envelope someone kept and replayed is not a message that arrived late.
5. `to`, when non-empty, is the receiver. Otherwise: rejected as addressed to someone
   else.
6. `pk` equals the key pinned for `from`. First key ever seen for an id **that is already
   in your contacts** is pinned, SSH-style. An id that is not in your contacts is
   rejected: nobody invited them and they invited nobody.

## Trust and keys

- A person has an ed25519 key pair (signing, above) and a secp256k1 Nostr key pair
  (transport). Both are created on join.
- An invitation is base64url JSON carrying **public** keys, relays, the newcomer's Slack
  id and name, a team name, and a single-use nonce. Never a secret; there is no flag to
  put one in.
- `kind: "hola"` announces a Nostr key. Over Nostr it is only accepted with the nonce of
  an invitation you issued, bound to what you wrote when inviting. Over Slack it must be
  signed with the ed25519 key already pinned for that id.
- `kind: "rota"` announces a **new** ed25519 key, signed with the old one; the signed
  text is the new public key. A contact with no pinned key cannot rotate.
- A key already in your contacts is never replaced by a hola. Only by a rotation, or by
  hand (`spoochie contacts --olvidar-clave`).

## Transports

**Nostr** (default when both sides have a key). NIP-59 gift wrap: the rumor holds the
text and the `sp` tag with the envelope; sealed and wrapped with NIP-44 to the
recipient's key, published to the sender's relays. Wrap kind `1059`, filtered by the `p`
tag. The relay sees an encrypted blob addressed to a pubkey and nothing else. Files
travel as 20 KB chunks, one envelope each.

**Slack**. The envelope rides in `metadata.event_payload` of the message; the text is the
message body. Anyone holding the bot token can post as anyone, which is exactly why the
signature exists.

## Limits

A message is capped, a patch is capped, and a patch that does not fit is **refused when
sent** rather than truncated (the sender is told to use a branch). Files: 10 MB.
Downloads cannot escape the spool: `../` in a name or id is rejected, and a thread id
from an envelope is validated on receipt and sanitised again on write.

## What the envelope deliberately does not carry

The auto-attached context is branch, SHA and up to 12 changed file **names**. Nothing
else is added automatically. Attaching more is convenient right up to the day a `.env`
slips into an envelope.
