---
description: Join spoochie with the invitation a teammate sent you
---

The user is joining spoochie. They pasted the invite a teammate sent them. Do this, in
order, and tell them the result in two or three sentences.

`spoochie` = `sh ${CLAUDE_PLUGIN_ROOT}/bin/spoochie`

## What they pasted

$ARGUMENTS

## Steps

1. Nothing needs installing: `spoochie` runs with the binary the startup hook downloaded
   and verified (or with Bun if they already have it). Do NOT ask them to install Bun. If
   the step 2 command fails with "neither the verified binary nor Bun is available", the
   session started without the hook: tell them to restart Claude Code and paste the
   invite again. Only if, after restarting, the hook says it could not download the
   binary is Bun the alternative (`curl -fsSL https://bun.sh/install | bash`).
2. `spoochie join <what they pasted, whole, as is>`. The command cleans up whatever is
   extra on its own (the leading "spoochie join", Slack's quotes, the plugin slash). The
   email comes from `git config user.email`; if Slack does not recognise it, the error
   says which one it tried. Then ask them for the email they use in Slack and repeat with
   `--email <mail>`.
3. `join` already runs the selftest at the end. If everything comes out `ok`, tell them
   they are in and that the first time someone opens a spoochie to them they will get a
   DM from the bot in Slack: replying in that thread accepts it. If anything comes out
   `FAIL`, show them that line as is.
4. Do not run `spoochie accept`, and do not change permissions or configuration. Only the join.
