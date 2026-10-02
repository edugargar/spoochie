# Spoochie for your company

Spoochie has nothing of ours inside: no server, no account, no data leaves your Slack and
your machines. Three things point at this repository, and a fork changes all three in
one place.

## Run it as is (recommended to start)

Nothing to change. Your team installs the plugin from this repository, you create the
Slack app from the manifest, you invite people. The only thing you depend on here is the
plugin and its binaries being published on GitHub by us, which they are, with
`SHA256SUMS`.

1. Create the Slack app: https://api.slack.com/apps → *Create New App* → *From a
   manifest* → paste `docs/slack-app-manifest.yml` → install it to your workspace.
2. On your machine, put the bot token where spoochie reads it and run
   `spoochie slack setup` (or `spoochie join` with an invitation from someone who
   already has it).
3. `spoochie invite --to <slack id> --name <name>` for each teammate. The bot DMs them
   the two plugin commands and the line to paste. That's the whole onboarding.

## Fork it (your plugin, your releases)

Do this if you want the plugin to come from your own GitHub, or you changed the code.

1. Fork `edugargar/spoochie` to `yourorg/spoochie`.
2. Edit `.claude-plugin/marketplace.json`: set `"name"` to `yourorg` and `"origin"` to
   `"yourorg/spoochie"`. That is the marketplace people add and the repository the
   session-start hook downloads verified binaries from.
3. Push a tag `vX.Y.Z`. The `release` workflow builds the four binaries and `SHA256SUMS`
   on GitHub's free runners. No secrets to configure: it uses the repository's own token.
4. Your teammates run `/plugin marketplace add yourorg/spoochie` and
   `/plugin install spoochie@yourorg`. Invitations sent from a forked install already say
   that.

`SPOOCHIE_ORIGIN=yourorg/spoochie` in the daemon's environment does the same without
touching files, for trying it out.

## What you get and what you don't

- Works inside one Slack workspace. Two companies with different Slacks can't spoochie
  each other (yet: see "The registry" in the README's roadmap).
- One bot token per workspace, shared by the team through invitations. Rotate it when
  someone leaves: `scripts/rotate-slack-token.sh` walks you through it.
- MIT. Do what you want; keep the notice.
