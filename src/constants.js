// What this harness is called, and the fixed values it runs with.

export const TYPE_ID = "antigravity-acp";
export const TITLE = "Antigravity (ACP)";
/** The plugin id, used when the host does not say which plugin owns a call. */
export const PLUGIN_ID = "local.antigravity-acp";
/** The `host.processes` entry in manifest.json: Google's Antigravity CLI
 * (`agy`) serving the Agent Client Protocol (`agy acp`), one worker process
 * per session, as it needs to reach a session's HTTP MCP server. */
export const PROCESS = "agy";
/** How a computer gets Antigravity CLI (Google's installer, into ~/.local/bin). */
export const INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

/** Antigravity's sign-in with a personal Google account: the one whose
 * Google AI Pro or Ultra plan pays for its agents. */
export const GOOGLE_LOGIN = "oauth-personal";
/** The plan Antigravity gives an account with no Google AI Pro or Ultra
 * plan, such as a Google Workspace account. */
export const FREE_TIER = "free-tier";

/** Permission modes, with Buzz's ids (as Buzz's Claude has them, so a
 * setting carries between the two), how Buzz describes each, and the
 * Antigravity mode it runs in. Buzz has no one to ask in the middle of a
 * turn, so a tool Antigravity asks about is allowed once, except in Plan. */
export const MODES = Object.freeze([
  ["bypassPermissions", "Bypass permissions", "Antigravity runs every tool without asking.", "accept-edits"],
  ["auto", "Auto", "Antigravity decides which actions need care; Buzz allows what it asks.", "auto"],
  ["acceptEdits", "Accept edits", "Edits files without asking; Buzz allows other tools.", "accept-edits"],
  ["plan", "Plan", "Antigravity plans and posts the plan; it changes nothing.", "plan"],
]);
/** The Antigravity mode for a Buzz permission mode. */
export const agentMode = (mode) => MODES.find(([id]) => id === mode)?.[3] ?? "accept-edits";

export const SCOPES = Object.freeze([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

/** Antigravity CLI's environment, over Buzz's own. Removed: each variable
 * that would make it use an API key, Vertex AI or another endpoint instead of
 * the person's own Google sign-in. */
export const ADAPTER_ENV = Object.freeze({
  GEMINI_API_KEY: null,
  GOOGLE_API_KEY: null,
  GOOGLE_GENAI_USE_VERTEXAI: null,
  GOOGLE_GEMINI_BASE_URL: null,
  AGY_ADC_AUTH: null,
  NO_COLOR: "1",
});

/** How long Antigravity may take to start, open a session or change one. */
export const START_TIMEOUT_MS = 120_000;
/** How long closing a session may take before it is left to the process. */
export const CLOSE_TIMEOUT_MS = 30_000;
/** How long signing in in the browser may take. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** An idle conversation closes its Antigravity session and MCP server after
 * this long, as Buzz's own ACP sessions do; its next turn resumes it. */
export const IDLE_MS = 15 * 60_000;
/** Antigravity sessions kept open at once across all agents. Each holds one
 * of the 64 loopback MCP servers Buzz allows all plugins together; past this,
 * the least recently used idle one closes first. */
export const MAX_LIVE_SESSIONS = 12;
/** Antigravity's last words kept for an error message. */
export const STDERR_LIMIT = 4_000;
/** Conversations whose sessions are remembered per agent, newest first. */
export const SAVED_CONVERSATIONS = 200;
/** Turns of a conversation's transcript kept, newest last. */
export const TRANSCRIPT_TURNS = 40;
/** Usage kept per agent: sessions, and model requests in each. */
export const USAGE_SESSIONS = 200;
export const USAGE_OBSERVATIONS = 1_000;
