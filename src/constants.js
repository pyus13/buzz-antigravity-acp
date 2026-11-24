// What this harness is called, and the fixed values it runs with.

export const TYPE_ID = "gemini-acp";
export const TITLE = "Gemini (ACP)";
/** The plugin id, used when the host does not say which plugin owns a call. */
export const PLUGIN_ID = "local.gemini-acp";
/** The `host.processes` entry in manifest.json. It runs the pinned Gemini CLI
 * in its Agent Client Protocol mode with `npx`, which downloads it once and
 * runs it from npm's cache after, so a computer needs only Node.js. */
export const PROCESS = "gemini";
/** What Gemini CLI needs on the computer (its `engines`). */
export const NODE_REQUIRED = "Node.js 20 or later";

/** Gemini CLI's sign-in with a Google account, the one a Google AI Pro or
 * Ultra subscription uses (its `AuthType.LOGIN_WITH_GOOGLE`). */
export const GOOGLE_LOGIN = "oauth-personal";

/** Permission modes, with Buzz's ids (as Buzz's other harnesses have them, so a
 * setting carries between the two) and the Gemini CLI approval mode each runs
 * in. Buzz has no one to ask in the middle of a turn, so a tool Gemini asks
 * about is allowed once, except in Plan. */
export const MODES = Object.freeze([
  ["bypassPermissions", "Bypass permissions", "Gemini runs every tool without asking (YOLO).", "yolo"],
  ["acceptEdits", "Accept edits", "Edits files without asking; Buzz allows other tools.", "autoEdit"],
  ["default", "Ask", "Gemini asks before each tool; Buzz allows it once.", "default"],
  ["plan", "Plan", "Gemini plans and posts the plan; it changes nothing.", "plan"],
]);
/** The Gemini CLI approval mode for a Buzz permission mode. */
export const geminiMode = (mode) => MODES.find(([id]) => id === mode)?.[3] ?? "yolo";

export const SCOPES = Object.freeze([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

/** Gemini CLI's environment, over Buzz's own. Removed: each variable that
 * would make Gemini use an API key or Vertex AI instead of the person's own
 * Google sign-in. Set: the agent's workspace is trusted, as its owner chose
 * it (Gemini otherwise refuses YOLO and Accept edits there), and npm quiet. */
export const ADAPTER_ENV = Object.freeze({
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  GEMINI_API_KEY: null,
  GOOGLE_API_KEY: null,
  GOOGLE_GENAI_USE_VERTEXAI: null,
  GOOGLE_GEMINI_BASE_URL: null,
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  GEMINI_SANDBOX: null,
  NO_COLOR: "1",
});

/** How long Gemini CLI may take to start: the first start downloads it. */
export const START_TIMEOUT_MS = 300_000;
/** How long opening a session or changing one may take. */
export const SESSION_TIMEOUT_MS = 120_000;
/** How long signing in in the browser may take. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** An idle conversation closes its MCP server after this long, as Buzz's own
 * ACP sessions do; its next turn loads the session again. */
export const IDLE_MS = 15 * 60_000;
/** Gemini sessions kept open at once across all agents. Each holds one of the
 * 64 loopback MCP servers Buzz allows all plugins together; past this, the
 * least recently used idle one closes first. */
export const MAX_LIVE_SESSIONS = 12;
/** Gemini CLI's last words kept for an error message. */
export const STDERR_LIMIT = 4_000;
/** Conversations whose sessions are remembered per agent, newest first. */
export const SAVED_CONVERSATIONS = 200;
/** Turns of a conversation's transcript kept, newest last. */
export const TRANSCRIPT_TURNS = 40;
/** Usage kept per agent: sessions, and model requests in each. */
export const USAGE_SESSIONS = 200;
export const USAGE_OBSERVATIONS = 1_000;
