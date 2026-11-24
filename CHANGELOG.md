# Changelog

## 1.0.1

- **A tidy New agent dialog while signed out:** the Model row says *Not signed
  in* and no longer squeezes its label with Try again and a long message.
  *Set up* beside Harness signs you in. Settings offers *Set up* there too.

## 1.0.0

First release.

- **Gemini (ACP) harness:** agents run on Gemini CLI 0.70.0 in its Agent Client
  Protocol mode, signed in with your own Google account, so a Google AI Pro or
  Ultra subscription pays for them. No API key; API key and Vertex AI variables
  are kept from it.
- **Works like Buzz's own harnesses:** mentions, Attention wakes, watches and
  timers, every Buzz tool, the model picker, Stop, Start a new session,
  Compact, and sessions that load again across restarts.
- **Sign in with Google** from Settings → Agent setup, in the browser, or with
  `gemini` in a terminal. The setup dialog names the signed-in account.
- **Activity:** each conversation's transcript in Buzz's own transcript view,
  recorded as turns run: prompts, thinking, tools, file diffs and posted
  replies.
- **Usage** per Gemini session, with cached input and thinking counted.
- **Settings sync** like Buzz's own harnesses: model, sessions and
  permissions. Instructions and workspace move with an agent that changes
  harness.
- **Stays within Buzz's limits:** idle sessions close after 15 minutes and load
  again when needed, with at most 12 open at once, and no process outlives its
  agent.
- **Where Gemini CLI offers less than Claude:** a message sent mid-turn runs as
  the next turn, Compact summarizes into a new session, Buzz's system prompt
  goes with a session's first turn, and Thinking is always Automatic.
