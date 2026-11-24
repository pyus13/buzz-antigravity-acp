<p align="center">
  <img src="plugin/icon.png" width="96" alt="">
</p>

<h1 align="center">Antigravity (ACP) for Buzz</h1>

<p align="center">
  Run your <a href="https://github.com/block/buzz-app">Buzz</a> agents on Google's <a href="https://antigravity.google">Antigravity CLI</a>, paid for by your own <b>Google AI Pro or Ultra</b> plan. No API key.
</p>

---

Google replaced Gemini CLI with Antigravity CLI (`agy`), and since June 18, 2026 Pro and Ultra plans
only work through Antigravity. This plugin runs `agy` as an
[Agent Client Protocol](https://agentclientprotocol.com) server (`agy acp`), signed in with your Google
account, so your agents use your plan's quota and every model it includes: Gemini, Claude and GPT-OSS.

## Quick start

1. **On your computer:** install Antigravity CLI.

   ```sh
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

2. **In Buzz:** Settings → Plugins → Manage plugins → **Add** → *Git or GitHub repository*

   | Field | Value |
   |---|---|
   | Repository | `pyus13/buzz-antigravity-acp` |
   | Folder | `plugin` |

3. **Sign in:** Settings → Agent setup → **Antigravity (ACP)** → **Sign in with Google**, and finish in
   your browser with the Google account that has your Pro or Ultra plan. Or run `agy` once in a
   terminal and sign in there; both share the sign-in.

4. **Create an agent** with Harness **Antigravity (ACP)** and mention it.

## What you get

- Mentions, wakes, watches and timers, with every Buzz tool
- Model and thinking pickers with the models your plan includes, steering, Stop, new session and compact
- Sessions that resume after a restart
- An Activity tab with each conversation's transcript, in Buzz's own transcript view
- Usage per session, in Buzz's usage views
- Settings → Agent setup shows your plan, and **Switch account** moves to another Google account

## Settings

| Setting | What it does |
|---|---|
| **Model**, **Thinking** | The models your plan includes, and each one's thinking levels. *Default* follows Settings → Agent setup. |
| **Instructions** | What the agent does. Added to Antigravity's own system prompt. |
| **Workspace** | The folder Antigravity works in. Default `~/.buzz`. |
| **Sessions** | One Antigravity session per thread, or per channel. |
| **Permissions** | *Bypass* runs every tool without asking (default). *Auto* lets Antigravity decide what needs care. *Plan* only posts a plan and changes nothing. |

## Troubleshooting

| You see | Do this |
|---|---|
| *needs Google's Antigravity CLI* | Run the install command above, then **Check again** in Settings → Agent setup. |
| *Sign in to Antigravity* | Press **Sign in with Google** in Settings → Agent setup, or run `agy` and sign in. |
| *no Google AI Pro or Ultra plan* | The signed-in account has no plan, so agents use Antigravity's free quota. Google Workspace (work) accounts don't include one. Press **Switch account** and sign in with the account that has your plan. |
| *could not finish: …* | The text after the colon is Antigravity's own error, such as a used-up quota. |

<details>
<summary><b>Other ways to install</b></summary>

- **From a release:** *Add from URL* with the release's `antigravity-acp-<version>.plugin.json` and its SHA-256 from `SHA256SUMS`.
- **From a folder:** clone this repository, then *Browse* to its `plugin` folder.
- **A fixed version:** put a release tag, like `v2.0.0`, in *Branch or tag*.

To update, open the plugin in Settings → Plugins and choose **Update**.

</details>

<details>
<summary><b>Develop</b></summary>

```sh
npm install
npm test           # unit, runtime and UI tests
npm run build      # src/ → plugin/plugin.js
npm run test:e2e   # real Antigravity CLI and your sign-in, a few turns
npm run icons      # redraw the icons
npm run release    # dist/ for a GitHub release
```

`src/` is bundled into the one file Buzz loads, `plugin/plugin.js`, which is committed so
GitHub installs need no build. Edit `src/`, never the bundle.

| Path | Owns |
|---|---|
| `src/index.js` | What the plugin registers with Buzz |
| `src/config.js` | Agent settings, sync and harness changes |
| `src/acp/` | The `agy acp` process and protocol |
| `src/runtime/` | Agents, conversations, sessions, models, defaults, transcripts, usage |
| `src/ui/` | Views built from Buzz's own components |
| `tools/icon/` | Icon sources |

`E2E_TRACE=/tmp/acp.log npm run test:e2e` records every ACP message, to see what a new `agy`
release changed.

**Releasing:** bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a
`vX.Y.Z` tag. The Release workflow publishes it.

</details>

## Notes

- Antigravity CLI keeps its sign-in in your system keychain, shared with `agy` in a terminal.
- In Plan, Buzz declines anything that would change a file or run a command, and asks Antigravity to post its plan.
- Antigravity CLI updates itself. If a new version changes its ACP server, `npm run test:e2e` shows what.
- macOS and Linux.

<sub>MIT License. Antigravity and Gemini are trademarks of Google. Not affiliated with Google or Block.</sub>
