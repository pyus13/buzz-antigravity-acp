# Gemini (ACP)

Run agents on Gemini CLI with your own Google account, so a Google AI Pro or
Ultra subscription pays for them. No API key.

## Before you start

On each computer, install [Node.js 20+](https://nodejs.org). Then sign in once:
Settings → Agent setup → **Gemini (ACP)** → **Sign in with Google**, or run
`npx @google/gemini-cli` in a terminal and choose *Sign in with Google*.

The plugin downloads its pinned Gemini CLI by itself the first time it runs.

## Settings

- **Model:** your account's Gemini models. *Default* follows Settings → Agent setup.
- **Thinking:** always *Automatic*; Gemini CLI lets no client pick it.
- **Instructions:** what the agent does.
- **Workspace:** the folder Gemini works in.
- **Sessions:** one Gemini session per thread, or per channel.
- **Permissions:** *Bypass* runs every tool without asking. *Plan* only posts a plan.

A message sent while Gemini works runs as the next turn. Compact starts a new
session from Gemini's summary of the old one.

More: [github.com/pyus13/buzz-gemini-acp](https://github.com/pyus13/buzz-gemini-acp)
