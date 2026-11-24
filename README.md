<p align="center">
  <img src="plugin/icon.png" width="96" alt="">
</p>

<h1 align="center">Gemini (ACP) for Buzz</h1>

<p align="center">
  Run your <a href="https://github.com/block/buzz-app">Buzz</a> agents on Gemini CLI with your own Google account, so your Google AI Pro or Ultra subscription pays for them. No API key.
</p>

---

## Quick start

1. **On your computer:** install [Node.js 20+](https://nodejs.org).

2. **In Buzz:** Settings → Plugins → Manage plugins → **Add** → *Git or GitHub repository*

   | Field | Value |
   |---|---|
   | Repository | `pyus13/buzz-gemini-acp` |
   | Folder | `plugin` |

3. **Sign in:** Settings → Agent setup → **Gemini (ACP)** → **Sign in with Google**, and finish in your browser. Or run `npx @google/gemini-cli` once in a terminal and choose *Sign in with Google*.

4. **Create an agent** with Harness **Gemini (ACP)** and mention it.

The plugin downloads its pinned Gemini CLI by itself the first time it runs.

## What you get

- Mentions, wakes, watches and timers, with every Buzz tool
- Model picker, Stop, new session and compact
- Sessions that load again after a restart or an idle close
- An Activity tab with each conversation's transcript, in Buzz's own transcript view
- Usage per session, in Buzz's usage views

## Settings

| Setting | What it does |
|---|---|
| **Model** | Your account's Gemini models. *Default* follows Settings → Agent setup, else Gemini's own (Auto). |
| **Thinking** | Always *Automatic*: Gemini CLI's ACP mode lets no client pick a thinking level. |
| **Instructions** | What the agent does. |
| **Workspace** | The folder Gemini works in. Default `~/.buzz`. |
| **Sessions** | One Gemini session per thread, or per channel. |
| **Permissions** | *Bypass* runs every tool without asking (YOLO, the default). *Accept edits* and *Ask* allow what Gemini asks about once. *Plan* only posts a plan. |

## How it differs from Buzz's Claude

Gemini CLI's ACP mode offers less than Claude's, so a few things work their own way:

- **A message sent while Gemini works** waits and runs as the next turn. Gemini can't take it into the running turn.
- **Compact** asks Gemini to summarize the session. The next message starts a new session from that summary, and is shown no message twice.
- **Buzz's system prompt** goes with a session's first turn, as Gemini CLI takes none of its own over ACP.
- **Transcripts and usage** are recorded by the plugin as turns run, on this computer. Turns run before you installed the plugin don't show.

## Troubleshooting

| You see | Do this |
|---|---|
| *needs Node.js 20 or later* | Install [Node.js](https://nodejs.org), then **Check again** in Settings → Agent setup. |
| *Sign in to Gemini* | Press **Sign in with Google** in Settings → Agent setup, or run `npx @google/gemini-cli` and choose *Sign in with Google*. |
| *can't reach the npm registry* | Connect to the internet once. After that it starts offline. |
| *could not finish: Rate limit exceeded* | Your plan's Gemini quota is used up for now. Try later, or pick a Flash model. |
| *could not finish: …* | The text after the colon is Gemini's own error. |

<details>
<summary><b>Other ways to install</b></summary>

- **From a release:** *Add from URL* with the release's `gemini-acp-<version>.plugin.json` and its SHA-256 from `SHA256SUMS`.
- **From a folder:** clone this repository, then *Browse* to its `plugin` folder.
- **A fixed version:** put a release tag, like `v1.0.0`, in *Branch or tag*.

To update, open the plugin in Settings → Plugins and choose **Update**.

</details>

<details>
<summary><b>Develop</b></summary>

```sh
npm install
npm test           # unit, runtime and UI tests
npm run build      # src/ → plugin/plugin.js
npm run test:e2e   # real Gemini CLI and your sign-in, a few turns
npm run icons      # redraw the icons
npm run release    # dist/ for a GitHub release
```

`src/` is bundled into the one file Buzz loads, `plugin/plugin.js`, which is committed so
installs need no build. Edit `src/`, never the bundle.

| Path | Owns |
|---|---|
| `src/index.js` | What the plugin registers with Buzz |
| `src/config.js` | Agent settings, sync and harness changes |
| `src/acp/` | The Gemini CLI process and protocol |
| `src/runtime/` | Agents, conversations, sessions, models, defaults, transcripts, usage |
| `src/ui/` | Views built from Buzz's own components |
| `tools/icon/` | Icon sources |

To move to a newer Gemini CLI, change the version in `plugin/manifest.json`, then run
`npm run test:e2e`.

**Releasing:** bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a
`vX.Y.Z` tag. The Release workflow publishes it.

</details>

## Notes

- Gemini CLI saves its sign-in in `~/.gemini`. Signing in here also signs in `gemini` in your terminal, and the other way round.
- The plugin trusts the agent's workspace for Gemini (`GEMINI_CLI_TRUST_WORKSPACE`), as its owner chose it. It never writes Gemini's settings, except that signing in saves *Sign in with Google* as your Gemini sign-in, as `gemini` does.
- macOS and Linux only.

<sub>MIT License. Gemini is a trademark of Google. Not affiliated with Google or Block.</sub>
