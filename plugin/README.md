# Antigravity (ACP)

Run agents on Google's Antigravity CLI, paid for by your own Google AI Pro or
Ultra plan. No API key.

## Before you start

On each computer, install Antigravity CLI:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Then sign in once: Settings → Agent setup → **Antigravity (ACP)** → **Sign in
with Google**, with the Google account that has your plan. Or run `agy` in a
terminal and sign in there.

## Settings

- **Model, Thinking:** the models your plan includes, and each one's thinking levels.
- **Instructions:** what the agent does.
- **Workspace:** the folder Antigravity works in.
- **Sessions:** one Antigravity session per thread, or per channel.
- **Permissions:** *Bypass* runs every tool without asking. *Plan* only posts a plan.

A Google Workspace (work) account has no Pro or Ultra plan: use **Switch
account** in Settings → Agent setup to sign in with yours.

More: [github.com/pyus13/buzz-antigravity-acp](https://github.com/pyus13/buzz-antigravity-acp)
