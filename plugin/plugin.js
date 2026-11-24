// Gemini (ACP) for Buzz 1.0.0. Built from src/ by scripts/build.mjs; edit the sources, not this file.

// src/constants.js
var TYPE_ID = "gemini-acp";
var TITLE = "Gemini (ACP)";
var PLUGIN_ID = "local.gemini-acp";
var PROCESS = "gemini";
var NODE_REQUIRED = "Node.js 20 or later";
var GOOGLE_LOGIN = "oauth-personal";
var MODES = Object.freeze([
  ["bypassPermissions", "Bypass permissions", "Gemini runs every tool without asking (YOLO).", "yolo"],
  ["acceptEdits", "Accept edits", "Edits files without asking; Buzz allows other tools.", "autoEdit"],
  ["default", "Ask", "Gemini asks before each tool; Buzz allows it once.", "default"],
  ["plan", "Plan", "Gemini plans and posts the plan; it changes nothing.", "plan"]
]);
var geminiMode = (mode) => MODES.find(([id]) => id === mode)?.[3] ?? "yolo";
var SCOPES = Object.freeze([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"]
]);
var ADAPTER_ENV = Object.freeze({
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  GEMINI_API_KEY: null,
  GOOGLE_API_KEY: null,
  GOOGLE_GENAI_USE_VERTEXAI: null,
  GOOGLE_GEMINI_BASE_URL: null,
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  GEMINI_SANDBOX: null,
  NO_COLOR: "1"
});
var START_TIMEOUT_MS = 3e5;
var SESSION_TIMEOUT_MS = 12e4;
var SIGN_IN_TIMEOUT_MS = 5 * 6e4;
var IDLE_MS = 15 * 6e4;
var MAX_LIVE_SESSIONS = 12;
var STDERR_LIMIT = 4e3;
var SAVED_CONVERSATIONS = 200;
var TRANSCRIPT_TURNS = 40;
var USAGE_SESSIONS = 200;
var USAGE_OBSERVATIONS = 1e3;

// src/config.js
var DEFAULTS = Object.freeze({
  model: "",
  effort: "",
  mode: "bypassPermissions",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread"
});
var MODE_IDS = MODES.map(([id]) => id);
function readConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const text = (key) => typeof raw[key] === "string" ? raw[key] : DEFAULTS[key];
  return {
    model: text("model").trim(),
    effort: text("effort").trim(),
    mode: MODE_IDS.includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    instructions: text("instructions"),
    workspace: text("workspace").trim() || DEFAULTS.workspace,
    scope: raw.scope === "channel" ? "channel" : "thread"
  };
}
var SYNCED_SCHEMA = Object.freeze({
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
  mode: MODE_IDS
});
function withSyncedSettings(config, settings) {
  const synced = Object.fromEntries(
    Object.keys(SYNCED_SCHEMA).filter((name) => typeof settings?.[name] === "string").map((name) => [name, settings[name]])
  );
  return { ...config, ...synced };
}
var sessionShape = (settings) => JSON.stringify([settings.instructions, settings.workspace, settings.scope]);
function carry(saved) {
  const { instructions, workspace } = readConfig(saved);
  return {
    ...instructions.trim() && { instructions },
    ...workspace !== DEFAULTS.workspace && { workspace }
  };
}
var adopt = (carried, config) => ({
  ...config,
  instructions: carried.instructions ?? config.instructions,
  workspace: carried.workspace ?? config.workspace
});
function describeMigration(saved) {
  const { model, effort, scope, mode } = readConfig(saved);
  return [
    { id: "model", label: "Model", isOverride: Boolean(model) },
    { id: "thinking", label: "Thinking", isOverride: Boolean(effort) },
    { id: "sessions", label: "Sessions", isOverride: scope !== DEFAULTS.scope, unchangedKey: scope },
    { id: "permissions", label: "Permissions", isOverride: mode !== DEFAULTS.mode }
  ];
}

// src/acp/protocol.js
var TOOL_LABELS = Object.freeze({
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  run_shell_command: "Shell",
  list_directory: "List",
  glob: "Glob",
  grep_search: "Search",
  search_file_content: "Search",
  google_web_search: "Web search",
  web_fetch: "Fetch",
  save_memory: "Memory",
  write_todos: "Todos",
  enter_plan_mode: "Plan",
  exit_plan_mode: "Plan",
  ask_user: "Ask",
  activate_skill: "Skill"
});
var KIND_LABELS = Object.freeze({
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Shell",
  think: "Thinking",
  fetch: "Fetch",
  switch_mode: "Plan"
});
var TARGET_LIMIT = 80;
var MODE_NOTE = /^\[MODE_UPDATE\]/;
function toolNameOf(call) {
  const mcp = call?._meta?.["gemini-cli"]?.mcp;
  if (typeof mcp?.server_name === "string" && typeof mcp?.tool_name === "string")
    return `mcp_${mcp.server_name}_${mcp.tool_name}`;
  const id = typeof call?.toolCallId === "string" ? call.toolCallId : "";
  const named = /^(.+?)[_-]\d{10,}[_-]\d+$/.exec(id)?.[1];
  if (named && !named.startsWith("synth_")) return named;
  const message = /^(send|reply_in_subthread)\(/.exec(typeof call?.title === "string" ? call.title : "")?.[1];
  return message ? `mcp_buzz_${message}` : void 0;
}
var buzzToolOf = (name) => typeof name === "string" ? /^mcp_buzz_(\w+)$/.exec(name)?.[1] : void 0;
var short = (text) => {
  const line = text.split("\n")[0].trim();
  const tail = line.startsWith("/") ? line.split("/").at(-1) || line : line;
  return tail.length > TARGET_LIMIT ? `${tail.slice(0, TARGET_LIMIT - 1)}\u2026` : tail;
};
function stepOf(update) {
  switch (update?.sessionUpdate) {
    case "tool_call": {
      const name = toolNameOf(update);
      const buzz = buzzToolOf(name);
      if (buzz) return { tool: buzz };
      const title = typeof update.title === "string" ? update.title.trim() : "";
      const tool = TOOL_LABELS[name] ?? KIND_LABELS[update.kind] ?? (name ? name.replace(/^mcp_/, "") : "Tool");
      const target = title && title !== name ? short(title) : "";
      return target ? { tool, target } : { tool };
    }
    case "agent_thought_chunk":
      return { tool: "Thinking" };
    case "agent_message_chunk":
      return MODE_NOTE.test(update.content?.text ?? "") ? void 0 : { tool: "Writing reply" };
    default:
      return void 0;
  }
}
var modeNote = (update) => MODE_NOTE.test(update?.content?.text ?? "");
function permissionAnswer(params, mode) {
  const options = (Array.isArray(params?.options) ? params.options : []).filter(
    (option) => typeof option?.optionId === "string"
  );
  const select = (option) => option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  const reject = () => select(options.find((option) => String(option.kind).startsWith("reject")));
  const name = toolNameOf(params?.toolCall);
  const leavesPlan = name === "exit_plan_mode" || params?.toolCall?.kind === "switch_mode";
  if (name === "ask_user") return reject();
  if (leavesPlan && (mode === "plan" || !mode)) return reject();
  return select(options.find((option) => option.kind === "allow_once"));
}
function modelsOf(answer) {
  const models = Array.isArray(answer?.models?.availableModels) ? answer.models.availableModels : [];
  return {
    current: typeof answer?.models?.currentModelId === "string" ? answer.models.currentModelId : void 0,
    choices: models.filter((model) => typeof model?.modelId === "string" && model.modelId).map((model) => ({
      value: model.modelId,
      name: typeof model.name === "string" && model.name ? model.name : model.modelId,
      description: typeof model.description === "string" && model.description ? model.description : void 0
    }))
  };
}
function modesOf(answer) {
  const modes = Array.isArray(answer?.modes?.availableModes) ? answer.modes.availableModes : [];
  return {
    current: typeof answer?.modes?.currentModeId === "string" ? answer.modes.currentModeId : void 0,
    ids: modes.map((mode) => mode?.id).filter((id) => typeof id === "string")
  };
}
var count = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
function observationsOf(answer, fallbackModel, at = Date.now()) {
  const usage = answer?.usage;
  if (!usage || typeof usage !== "object") return [];
  const input = count(usage.inputTokens);
  const cached = Math.min(count(usage.cachedReadTokens), input);
  const output = count(usage.outputTokens) + count(usage.thoughtTokens);
  if (!input && !output) return [];
  const perModel = (Array.isArray(answer?._meta?.quota?.model_usage) ? answer._meta.quota.model_usage : []).filter(
    (entry) => typeof entry?.model === "string" && entry.model
  );
  const tokens = (inputCount, outputCount, cache) => ({
    input: Math.max(0, inputCount - cache),
    output: outputCount,
    ...cache ? { cacheRead: cache } : {}
  });
  if (perModel.length <= 1)
    return [{ at, model: perModel[0]?.model ?? fallbackModel ?? "gemini", tokens: tokens(input, output, cached) }];
  const largest = perModel.reduce(
    (top, entry) => count(entry.token_count?.input_tokens) > count(top.token_count?.input_tokens) ? entry : top
  );
  return perModel.map((entry) => {
    const own = entry === largest;
    const entryInput = count(entry.token_count?.input_tokens);
    const entryOutput = count(entry.token_count?.output_tokens) + (own ? count(usage.thoughtTokens) : 0);
    return { at, model: entry.model, tokens: tokens(entryInput, entryOutput, own ? Math.min(cached, entryInput) : 0) };
  });
}
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const data = typeof error.data === "string" ? error.data : error.data?.message;
    return data ? `${error.message}: ${data}` : String(error.message);
  }
  return String(error);
}
var needsSignIn = (error) => /auth(entication)? required|api key is missing|not configured|login required|sign.?in|credentials|unauthenticated|invalid_grant|-32000/i.test(
  errorText(error)
) || error?.code === -32e3;
var lastLines = (text, count2 = 6) => text.trim().split("\n").slice(-count2).join("\n");
var effortLabel = (id) => id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
function promptSections(text) {
  const sections = [];
  const loose = [];
  let open;
  for (const line of String(text).split("\n")) {
    if (open) {
      if (line === `</${open.tag}>`) {
        sections.push({ tag: open.tag, body: open.lines.join("\n") });
        open = void 0;
      } else open.lines.push(line);
      continue;
    }
    const start = /^<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>$/.exec(line);
    if (start && start[1] !== "owner-section" && start[1] !== "plugin-section") open = { tag: start[1], lines: [] };
    else loose.push(line);
  }
  if (open) loose.push(`<${open.tag}>`, ...open.lines);
  const rest = loose.join("\n").trim();
  if (rest) sections.push({ tag: "text", body: rest });
  return sections;
}

// src/acp/connection.js
var CLIENT_INFO = { name: "buzz-gemini-acp", version: true ? "1.0.0" : "dev" };
var STALE_CACHE = /ETARGET|notarget|No matching version/;
var OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network/i;
var AcpConnection = class _AcpConnection {
  /** Starts Gemini CLI in `cwd` and completes the ACP handshake. With an
   * `agent`, the process carries a Buzz credential that acts as that agent,
   * so `buzz` commands Gemini runs reach the community as it (newer Buzz).
   *
   * npx runs the pinned Gemini CLI from npm's cache, which is quick and works
   * offline. A cache older than that release doesn't list it yet; then the
   * start is tried once more with the registry. */
  static async start(host, options) {
    try {
      return await _AcpConnection.open(host, options, { npm_config_prefer_offline: "true" });
    } catch (error) {
      if (!error.staleCache) throw error;
      return _AcpConnection.open(host, options, { npm_config_prefer_offline: "false" });
    }
  }
  static async open(host, { cwd, agent, permissionMode, onStderr }, npm) {
    const connection = new _AcpConnection(permissionMode, onStderr);
    try {
      await connection.spawn(host, cwd, agent, npm);
      if (agent && typeof connection.process.actAs === "function")
        await connection.process.actAs({ pubkey: agent.pubkey, relay: agent.relay }).catch((error) => {
          console.warn("gemini-acp: could not bind the agent's credential", error);
        });
      connection.info = await connection.request(
        "initialize",
        {
          protocolVersion: 1,
          // Gemini CLI reads and writes files and runs commands itself.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: CLIENT_INFO
        },
        START_TIMEOUT_MS
      );
      return connection;
    } catch (error) {
      void connection.stop();
      throw connection.startFailure(error);
    }
  }
  /** Why Gemini CLI didn't start, in words a person can act on. */
  startFailure(error) {
    const said = this.stderr;
    if (!/npm (error|ERR)/.test(said)) return error;
    if (STALE_CACHE.test(said)) return Object.assign(new Error(errorText(error)), { staleCache: true });
    if (OFFLINE.test(said))
      return new Error(
        `${TITLE} couldn't download Gemini CLI: this computer can't reach the npm registry. Connect once; after that it starts offline.`
      );
    return new Error(`${TITLE} couldn't install Gemini CLI with npm:
${lastLines(said, 4)}`);
  }
  /** `permissionMode(sessionId)`: the mode a session runs in, which decides
   * how its permission prompts are answered. */
  constructor(permissionMode = () => void 0, onStderr = void 0) {
    this.permissionMode = permissionMode;
    this.onStderr = onStderr;
    this.process = void 0;
    this.info = void 0;
    this.closed = void 0;
    this.stopped = false;
    this.stderr = "";
    this.nextId = 0;
    this.pending = /* @__PURE__ */ new Map();
    this.sessionListeners = /* @__PURE__ */ new Map();
    this.closeListeners = /* @__PURE__ */ new Set();
  }
  async spawn(host, cwd, agent, npm = {}) {
    let buffer = "";
    try {
      this.process = await host.spawn(PROCESS, {
        cwd,
        env: { ...ADAPTER_ENV, ...npm },
        ...agent ? { agentCredential: true } : {},
        onStdout: (data) => {
          buffer += data;
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line) this.receive(line);
          }
        },
        onStderr: (data) => {
          this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
          this.onStderr?.();
        }
      });
    } catch (error) {
      const reason = errorText(error);
      throw new Error(
        /no such file|not found|os error 2|enoent/i.test(reason) ? `${TITLE} needs ${NODE_REQUIRED} on this computer. Install it from https://nodejs.org, then press Check again in Settings \u2192 Agent setup.` : `Could not start Gemini CLI (${reason}).`
      );
    }
    void this.process.exited.then(
      (code) => {
        const status = code === null || code === void 0 ? "" : ` with exit code ${code}`;
        const said = this.stderr.trim() ? `:
${lastLines(this.stderr)}` : "";
        this.close(`${TITLE} stopped${status}${said}`);
      },
      (error) => this.close(`${TITLE} stopped: ${errorText(error)}`)
    );
  }
  get capabilities() {
    return this.info?.agentCapabilities ?? {};
  }
  /** Whether a saved session can be opened again (`session/load`). */
  get canLoad() {
    return this.capabilities.loadSession === true;
  }
  /** Whether the agent offers the sign-in with a Google account. */
  get offersGoogleLogin() {
    return (Array.isArray(this.info?.authMethods) ? this.info.authMethods : []).some(
      (method) => method?.id === GOOGLE_LOGIN
    );
  }
  /** Calls `listener` with each `session/update` for `sessionId`. */
  onSession(sessionId, listener) {
    this.sessionListeners.set(sessionId, listener);
    return () => {
      if (this.sessionListeners.get(sessionId) === listener) this.sessionListeners.delete(sessionId);
    };
  }
  /** Calls `listener` once with the reason when the connection ends. */
  onClose(listener) {
    if (this.closed) {
      listener(this.closed, this.stopped);
      return () => {
      };
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs && setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${TITLE} did not answer ${method} in time`));
      }, timeoutMs);
      const settle = (done) => (value) => {
        clearTimeout(timer);
        done(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }
  write(message) {
    this.process.write(`${JSON.stringify(message)}
`).catch((error) => {
      this.close(`Could not write to ${TITLE}: ${errorText(error)}`);
    });
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message?.method === "string") {
      const params = message.params ?? {};
      if (message.method === "session/update" && params.update)
        this.sessionListeners.get(params.sessionId)?.(params.update);
      if (message.id !== void 0 && message.id !== null)
        this.write({ jsonrpc: "2.0", id: message.id, ...this.answer(message.method, params) });
      return;
    }
    const waiter = this.pending.get(message?.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(errorText(message.error));
      error.code = message.error.code;
      waiter.reject(error);
    } else waiter.resolve(message.result);
  }
  /** Answers a request Gemini CLI makes of Buzz. */
  answer(method, params) {
    if (method === "session/request_permission")
      return { result: permissionAnswer(params, this.permissionMode(params.sessionId)) };
    if (method.startsWith("_")) return { result: {} };
    return { error: { code: -32601, message: `Buzz does not offer ${method}` } };
  }
  close(reason) {
    if (this.closed) return;
    this.closed = reason;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    this.sessionListeners.clear();
    for (const listener of this.closeListeners) listener(reason, this.stopped);
    this.closeListeners.clear();
  }
  /** Ends the connection and stops the process and its children. */
  stop() {
    this.stopped = true;
    this.close(`${TITLE} was stopped`);
    return this.process?.kill().catch(() => {
    }) ?? Promise.resolve();
  }
};

// src/runtime/conversation.js
var STOPPED = Object.freeze({ ok: true, stopped: true });
var SETTLE_MS = 5e3;
var SUMMARY_LIMIT = 4e4;
var EVENT_ID = /\b[0-9a-f]{64}\b/;
var MESSAGE_TOOLS = /* @__PURE__ */ new Set(["send", "reply_in_subthread"]);
var COMPACT_PROMPT = `Your context is being compacted: this session ends here, and a new session continues it from your summary alone.

Write that summary now, for yourself. Include who you are working with and what they asked, the decisions made, the work done (files, commands and their results), where things stand, and every open task or promise. Be concise but leave out nothing you will need.

Do not call any tools. Answer with the summary only.`;
function sessionParams(cwd, mcp) {
  return {
    cwd,
    mcpServers: [{ type: "http", name: "buzz", url: mcp.url, headers: mcp.headers.map((header) => ({ ...header })) }]
  };
}
function sessionState(answer) {
  const models = modelsOf(answer);
  const modes = modesOf(answer);
  return {
    model: models.current,
    defaultModel: models.current,
    models: models.choices.map((choice) => choice.value),
    names: Object.fromEntries(models.choices.map((choice) => [choice.value, choice.name])),
    mode: modes.current,
    modes: modes.ids
  };
}
async function applySettings(connection, sessionId, state, wanted) {
  const next = { ...state };
  const [mode, modeSynced] = wanted.mode;
  if (mode && next.mode !== mode) {
    if (next.modes.length && !next.modes.includes(mode)) {
      if (modeSynced)
        throw new Error(`This agent's synced permissions "${mode}" aren't offered by ${TITLE}. Change them in Settings.`);
    } else {
      await connection.request("session/set_mode", { sessionId, modeId: mode }, SESSION_TIMEOUT_MS);
      next.mode = mode;
    }
  }
  const [picked, modelSynced] = wanted.model;
  const model = picked || next.defaultModel;
  if (model && next.model !== model) {
    if (next.models.length && !next.models.includes(model)) {
      if (modelSynced)
        throw new Error(`This agent's synced model "${model}" isn't offered by ${TITLE}. Change it in Settings.`);
    } else {
      await connection.request("session/set_model", { sessionId, modelId: model }, SESSION_TIMEOUT_MS);
      next.model = model;
    }
  }
  return next;
}
function wantedSettings(delivery, settings, defaults) {
  const synced = delivery.synced ?? {};
  const effective = defaults.effective(settings).model;
  return {
    mode: [geminiMode(settings.mode), "mode" in synced],
    model: [
      delivery.model || (effective === "default" ? "" : effective),
      !delivery.model && Boolean(settings.model) && "model" in synced
    ]
  };
}
function outcomeOf(stopReason) {
  if (stopReason === "cancelled") return STOPPED;
  if (stopReason === "refusal") return { ok: false, error: "Gemini declined to continue this turn." };
  if (stopReason === "max_tokens")
    return { ok: false, error: "Gemini's context window is full. Compact the session or start a new one." };
  if (stopReason === "max_turn_requests")
    return { ok: false, error: "Gemini stopped this turn: it detected a loop or reached its turn limit." };
  return { ok: true };
}
var transcriptOutcome = (result) => result.stopped ? "stopped" : result.ok ? "ended" : "error";
var sessionLost = (error, connection) => Boolean(connection?.closed) || /session not found|unknown session|exited unexpectedly/i.test(errorText(error));
var sessionGone = (error) => /not found|no previous sessions|invalid session identifier|no such file|enoent/i.test(errorText(error));
var AMBIENT = /* @__PURE__ */ new Set(["available_commands_update", "current_mode_update", "config_option_update"]);
var Turn = class {
  constructor(delivery, { compacting = false } = {}) {
    this.delivery = delivery;
    this.compacting = compacting;
    this.updated = false;
    this.step = "";
    this.text = "";
    this.record = void 0;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
};
var Conversation = class {
  constructor(agent, key, record) {
    this.agent = agent;
    this.key = key;
    this.record = record;
    this.connection = void 0;
    this.live = false;
    this.state = void 0;
    this.mcp = void 0;
    this.handler = void 0;
    this.unsubscribe = void 0;
    this.system = void 0;
    this.turn = void 0;
    this.starting = void 0;
    this.queue = [];
    this.pumping = false;
    this.idleTimer = void 0;
    this.mode = void 0;
    this.used = record?.at ?? 0;
  }
  get busy() {
    return Boolean(this.turn || this.starting || this.queue.length);
  }
  /** As Buzz's session controls show it. */
  get controlState() {
    if (this.turn?.compacting) return "compacting";
    return this.busy ? "active" : "idle";
  }
  /** A DM, Solo chat or channel-scoped conversation: one per channel. */
  get whole() {
    return Boolean(this.record?.whole ?? this.wholeNow);
  }
  // --- deliveries
  /** Runs a mention or wake in this conversation as its next turn. Gemini
   * CLI can't take a message into a running turn, so one that arrives while
   * Gemini works waits for the turn to end. */
  async deliver(delivery, conversation, settings) {
    this.used = Date.now();
    this.wholeNow = conversation.key === conversation.channel;
    const item = { delivery, conversation, settings, stopped: false };
    item.done = new Promise((resolve) => {
      item.resolve = resolve;
    });
    this.queue.push(item);
    delivery.workingUntil(item.done);
    delivery.interruptible?.(async () => this.stop(item));
    this.agent.changed();
    void this.pump();
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.turn && this.queue.length && !this.agent.disposed) {
        const item = this.queue.shift();
        if (item.stopped) {
          item.resolve(STOPPED);
          continue;
        }
        if (item.delivery.current && !item.delivery.current()) {
          item.delivery.ignored?.();
          item.resolve({ ok: true });
          continue;
        }
        this.starting = item;
        this.agent.changed();
        const result = await this.runTurn(item).catch(
          (error) => this.agent.disposed ? STOPPED : { ok: false, error: errorText(error) }
        );
        this.starting = void 0;
        item.resolve(result);
        if (!result.ok && result.error) await this.agent.report(item, result.error);
      }
    } finally {
      this.pumping = false;
      this.starting = void 0;
      this.scheduleIdle();
      this.agent.changed();
    }
  }
  async runTurn(item, retried = false) {
    const { delivery, conversation, settings } = item;
    await this.open(delivery, conversation, settings);
    if (item.stopped) return STOPPED;
    this.state = await applySettings(
      this.connection,
      this.record.sessionId,
      this.state,
      wantedSettings(delivery, settings, this.agent.defaults)
    );
    this.mode = settings.mode;
    if (item.stopped) return STOPPED;
    const before = { cursor: this.record.cursor, primed: this.record.primed, summary: this.record.summary };
    const prompt = await this.agent.kit.turnPrompt(delivery, conversation, this.cursorOption());
    if (item.stopped) {
      prompt.restore();
      return STOPPED;
    }
    const system = this.record.primed ? void 0 : this.system;
    const summary = this.record.summary;
    const text = [
      system,
      summary && `<previous-session-summary>
${summary}
</previous-session-summary>`,
      prompt.text
    ].filter(Boolean).join("\n\n");
    const turn = new Turn(delivery);
    const { connection } = this;
    const sessionId = this.record.sessionId;
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId,
      newSession: !this.record.primed,
      channelId: conversation.channel,
      root: conversation.root,
      delivery,
      system,
      prompt: summary ? `<previous-session-summary>
${summary}
</previous-session-summary>

${prompt.text}` : prompt.text,
      config: this.configLabels()
    });
    this.turn = turn;
    this.starting = void 0;
    this.agent.changed();
    let result;
    try {
      const sent = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      this.record.cursor = prompt.cursor;
      this.record.primed = true;
      delete this.record.summary;
      this.save();
      delivery.acknowledged?.();
      const answer = await sent;
      result = outcomeOf(answer?.stopReason);
      void this.agent.recordUsage({
        sessionId,
        channelId: conversation.channel,
        root: conversation.root,
        observations: observationsOf(answer, this.state?.model)
      });
    } catch (error) {
      if (!turn.updated && this.record) {
        prompt.restore();
        Object.assign(this.record, before);
        if (before.summary === void 0) delete this.record.summary;
      }
      if (sessionLost(error, connection)) this.lose();
      if (this.agent.disposed || connection.stopped) result = STOPPED;
      else if (!turn.updated && !retried && sessionLost(error, connection)) {
        this.turn = void 0;
        this.starting = item;
        turn.record.end({ outcome: "error", error: `${errorText(error)} (retrying)` });
        turn.finish({ ok: true });
        return this.runTurn(item, true);
      } else result = { ok: false, error: errorText(error) };
    } finally {
      if (this.turn === turn) this.turn = void 0;
      if (this.record) this.record.at = Date.now();
      this.save();
      this.agent.changed();
    }
    turn.record.end({ outcome: transcriptOutcome(result), error: result.error });
    turn.finish(result);
    return result;
  }
  cursorOption() {
    return this.record?.cursor ? { cursor: this.record.cursor } : void 0;
  }
  /** The model and permissions a turn ran with, as its transcript shows them. */
  configLabels() {
    const model = this.state?.model;
    const mode = MODES.find(([, , , id]) => id === this.state?.mode)?.[1];
    return [model && (this.state?.names?.[model] ?? this.agent.modelLabel(model)), mode].filter(Boolean);
  }
  // --- the Gemini session
  /** Makes the session live for this turn: reuses it, loads it, or starts a
   * new one, each with a fresh MCP server (a server takes one MCP session, so
   * every new or loaded Gemini session needs its own). */
  async open(delivery, conversation, settings) {
    const agentHandle = delivery.agent;
    const connection = await this.agent.connect(agentHandle, settings);
    const cwd = await this.agent.workspace(settings);
    this.handler = this.agent.tools(agentHandle, conversation, cwd);
    if (typeof conversation.where === "string") this.where = conversation.where;
    const shape = sessionShape(settings);
    if (this.live && this.connection === connection && this.record?.shape === shape) {
      this.agent.opened(this);
      return;
    }
    await this.close();
    if (this.record?.shape !== void 0 && this.record.shape !== shape) this.forget();
    await this.agent.makeRoom(this);
    this.agent.opened(this);
    try {
      await this.start(delivery, settings, connection, cwd, shape);
    } catch (error) {
      this.lose();
      throw error;
    }
  }
  async start(delivery, settings, connection, cwd, shape) {
    const mcp = await this.agent.host.serveMcp((message) => this.answerMcp(message));
    this.mcp = mcp;
    void mcp.closed?.then(() => {
      if (this.mcp === mcp) this.lose();
    });
    this.system = await this.agent.kit.systemPrompt(delivery, {
      scope: settings.scope,
      cwd,
      instructions: settings.instructions
    });
    const params = sessionParams(cwd, mcp);
    let opened;
    if (this.record?.sessionId && !this.record.compacted && connection.canLoad)
      opened = await connection.request("session/load", { sessionId: this.record.sessionId, ...params }, SESSION_TIMEOUT_MS).catch((error) => {
        if (connection.closed || !sessionGone(error)) throw error;
        console.warn("gemini-acp: the saved session is gone; starting a new one", error);
        return void 0;
      });
    if (opened) {
      if (this.record.primed === void 0) this.record.primed = true;
    } else {
      const carried = this.record?.compacted ? { ...this.record.cursor ? { cursor: this.record.cursor } : {}, summary: this.record.summary } : {};
      if (this.record) this.forget();
      opened = await connection.request("session/new", params, SESSION_TIMEOUT_MS);
      this.record = { sessionId: opened.sessionId, at: Date.now(), primed: false, ...carried };
    }
    this.record.shape = shape;
    this.record.whole = this.whole;
    if (this.where) this.record.where = this.where;
    this.connection = connection;
    this.state = sessionState(opened);
    this.unsubscribe = connection.onSession(this.record.sessionId, (update) => this.update(update));
    this.live = true;
    this.save();
  }
  /** Answers the session's Buzz tools with this turn's handler, recording
   * the messages its message tools post. */
  answerMcp(message) {
    if (!this.handler)
      return Promise.resolve(
        message?.id === void 0 ? void 0 : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "No Buzz turn is running" } }
      );
    const answer = Promise.resolve(this.handler(message));
    const call = message?.method === "tools/call" ? message.params : void 0;
    const record = this.turn?.record;
    if (!record || !MESSAGE_TOOLS.has(call?.name)) return answer;
    return answer.then((reply) => {
      const result = reply?.result;
      if (!reply?.error && !result?.isError) {
        const said = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
        record.posted(call.arguments?.text, EVENT_ID.exec(said)?.[0]);
      }
      return reply;
    });
  }
  update(update) {
    const turn = this.turn;
    if (!turn || AMBIENT.has(update?.sessionUpdate)) return;
    turn.updated = true;
    turn.record?.update(update);
    if (turn.compacting) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && !modeNote(update)) {
        if (update._meta?.reset) turn.text = "";
        turn.text += update.content.text;
      }
      return;
    }
    const step = stepOf(update);
    if (!step) return;
    const label = `${step.tool}\0${step.target ?? ""}`;
    if (label === turn.step) return;
    turn.step = label;
    turn.delivery?.step?.(step.tool, step.target);
  }
  /** The session can't be used as it is: the next turn opens it again. */
  lose() {
    this.live = false;
    this.unsubscribe?.();
    this.unsubscribe = void 0;
    const mcp = this.mcp;
    this.mcp = void 0;
    void mcp?.close().catch(() => {
    });
    this.agent.closed(this);
    if (!this.busy) this.agent.idle();
  }
  /** Closes the session's MCP server, keeping the record so the next turn
   * loads the session again. Gemini CLI has no way to close one session; it
   * is let go of, and goes with its process once the agent is idle. */
  async close() {
    clearTimeout(this.idleTimer);
    this.lose();
  }
  /** Forgets the session: the next turn starts a new one. Its transcript
   * stays. */
  forget() {
    this.record = void 0;
    this.agent.forget(this.key);
  }
  save() {
    this.agent.save(this);
  }
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (!this.live || this.busy) return;
    this.idleTimer = setTimeout(() => {
      if (!this.busy) void this.close().then(() => this.agent.idle());
    }, IDLE_MS);
  }
  // --- controls
  /** Stops `item` if it is still queued or starting, else the running turn. */
  stop(item) {
    if (item) {
      const queued = this.queue.indexOf(item);
      if (queued >= 0) {
        this.queue.splice(queued, 1);
        item.resolve(STOPPED);
        this.agent.changed();
        return;
      }
    }
    if (this.starting && (!item || this.starting === item)) this.starting.stopped = true;
    if (item && this.turn && this.turn.delivery !== item.delivery) return;
    if (this.turn && this.record && this.connection && !this.connection.closed)
      this.connection.notify("session/cancel", { sessionId: this.record.sessionId });
  }
  /** Stops everything: the running turn and every queued message. */
  interrupt() {
    for (const item of this.queue.splice(0)) item.resolve(STOPPED);
    this.stop();
    this.agent.changed();
  }
  /** Ends the session for good; the next message starts a new one. */
  async reset() {
    const pending = [this.turn?.done, this.starting?.done].filter(Boolean);
    this.interrupt();
    if (pending.length)
      await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
    await this.close();
    this.forget();
    this.agent.changed();
    this.agent.idle();
  }
  /** Compacts the session: Gemini CLI has no compaction a client can ask
   * for, so Gemini summarizes the session, and the next message starts a new
   * session from that summary, shown no message twice. */
  async compact() {
    if (this.busy) throw new Error("Wait for the active turn to finish first.");
    if (!this.record) throw new Error("This conversation has no Gemini session yet.");
    if (!this.live)
      throw new Error("This conversation's Gemini session is closed. It opens again with the next message.");
    const turn = new Turn(void 0, { compacting: true });
    const { connection } = this;
    const { sessionId } = this.record;
    const [channelId, root] = this.key.split("/");
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId,
      newSession: false,
      channelId,
      root,
      config: this.configLabels()
    });
    turn.record.status("Compacting: Gemini summarizes this session, and the next message starts a new one from the summary.");
    this.turn = turn;
    this.handler = void 0;
    this.agent.changed();
    try {
      const answer = await connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: COMPACT_PROMPT }]
      });
      const outcome = outcomeOf(answer?.stopReason);
      void this.agent.recordUsage({ sessionId, channelId, root, observations: observationsOf(answer, this.state?.model) });
      if (outcome.stopped || !outcome.ok) {
        turn.record.end({ outcome: transcriptOutcome(outcome), error: outcome.error });
        turn.finish(outcome);
        if (outcome.error) throw new Error(outcome.error);
        return;
      }
      const summary = turn.text.trim();
      if (!summary) throw new Error("Gemini returned no summary, so the session was kept.");
      await this.close();
      this.record = {
        ...this.record,
        compacted: true,
        primed: false,
        summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}\u2026` : summary,
        at: Date.now()
      };
      this.save();
      turn.record.end({ outcome: "ended" });
      turn.finish({ ok: true });
    } catch (error) {
      turn.record.end({ outcome: "error", error: errorText(error) });
      turn.finish({ ok: false, error: errorText(error) });
      throw error;
    } finally {
      if (this.turn === turn) this.turn = void 0;
      this.agent.changed();
      void this.pump();
      this.agent.idle();
    }
  }
  /** The agent is gone: stop quietly; its process is being stopped too. */
  dispose() {
    clearTimeout(this.idleTimer);
    for (const item of this.queue.splice(0)) item.resolve(STOPPED);
    if (this.starting) this.starting.stopped = true;
    this.lose();
  }
};

// src/runtime/agent.js
var REMOVED = "This agent was removed";
var AgentRuntime = class {
  constructor(runtime, key) {
    this.runtime = runtime;
    this.key = key;
    this.kit = runtime.kit;
    this.host = runtime.host;
    this.defaults = runtime.defaults;
    this.transcripts = runtime.transcripts;
    this.conversations = /* @__PURE__ */ new Map();
    this.records = void 0;
    this.loaded = runtime.records.load(key).then((records) => {
      this.records = records;
      runtime.notify();
    });
    this.connection = void 0;
    this.connecting = void 0;
    this.standalone = /* @__PURE__ */ new Map();
    this.starting = 0;
    this.disposed = false;
  }
  /** The conversation for `key`, with the session it saved, if any. */
  async conversation(key) {
    await this.loaded;
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = new Conversation(this, key, this.records[key]);
      this.conversations.set(key, conversation);
    }
    return conversation;
  }
  /** The conversation already in memory for a place, for session controls. */
  conversationAt(place, scope) {
    const own = scope === "thread" && place.root ? `${place.channelId}/${place.root}` : place.channelId;
    const found = this.conversations.get(own);
    if (found || own === place.channelId) return found;
    const whole = this.conversations.get(place.channelId);
    return whole?.whole ? whole : void 0;
  }
  /** The key a place's saved session is under, for controls on a
   * conversation not yet in memory. */
  savedKeyAt(place, scope) {
    const own = scope === "thread" && place.root ? `${place.channelId}/${place.root}` : place.channelId;
    if (this.records?.[own] || own === place.channelId) return own;
    return this.records?.[place.channelId]?.whole ? place.channelId : own;
  }
  // --- the Gemini CLI process
  /** The agent's Gemini CLI process, started on first use. */
  async connect(agentHandle, settings) {
    if (this.disposed) throw new Error(REMOVED);
    if (this.connection && !this.connection.closed) return this.connection;
    this.connecting ??= (async () => {
      const cwd = await this.workspace(settings);
      const connection = await AcpConnection.start(this.host, {
        cwd,
        agent: agentHandle,
        permissionMode: (sessionId) => this.modeOf(sessionId)
      });
      if (this.disposed) {
        void connection.stop();
        throw new Error(REMOVED);
      }
      connection.onClose((reason, stopped) => {
        if (this.connection === connection) this.connection = void 0;
        for (const conversation of this.conversations.values())
          if (conversation.connection === connection) conversation.lose();
        if (!stopped) console.warn(`gemini-acp: ${reason}`);
        this.changed();
      });
      this.connection = connection;
      return connection;
    })().finally(() => {
      this.connecting = void 0;
    });
    return this.connecting;
  }
  workspace(settings) {
    return this.host.resolveDirectory(settings.workspace);
  }
  /** The conversation's Buzz tools, answered over MCP, for this turn. */
  tools(agentHandle, conversation, cwd) {
    const read = this.host.readFile && ((path) => this.host.readFile(path, { cwd }));
    return this.kit.tools(agentHandle, conversation, read ? { read } : void 0);
  }
  /** The permission mode of the session `sessionId` runs in, if known. */
  modeOf(sessionId) {
    if (this.standalone.has(sessionId)) return this.standalone.get(sessionId);
    for (const conversation of this.conversations.values())
      if (conversation.record?.sessionId === sessionId) return conversation.mode;
    return void 0;
  }
  /** Stops the process once nothing has a session open in it. */
  idle() {
    const open = [...this.conversations.values()].some((conversation) => conversation.live || conversation.busy);
    if (!open && !this.standalone.size && !this.starting && !this.connecting) void this.connection?.stop();
  }
  // --- saved sessions
  save(conversation) {
    if (!this.records || this.disposed) return;
    if (conversation.record) this.records[conversation.key] = conversation.record;
    else delete this.records[conversation.key];
    void this.runtime.records.save(this.key, this.records);
  }
  forget(key) {
    if (!this.records) return;
    delete this.records[key];
    void this.runtime.records.save(this.key, this.records);
  }
  /** The agent's sessions for views across agents, newest first. */
  sessions() {
    if (!this.records) return [];
    const keys = /* @__PURE__ */ new Set([...Object.keys(this.records), ...this.conversations.keys()]);
    return [...keys].map((key) => {
      const conversation = this.conversations.get(key);
      const record = conversation ? conversation.record : this.records[key];
      if (!record) return void 0;
      const [channelId, root] = key.split("/");
      return {
        channelId,
        ...root ? { root } : {},
        at: Math.max(record.at ?? 0, conversation?.used ?? 0),
        ...conversation?.live || conversation?.busy ? { status: conversation.busy ? "Working" : "Idle" } : {}
      };
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  /** The agent's conversations for its Activity tab, newest first. */
  rows() {
    if (!this.records) return [];
    const keys = /* @__PURE__ */ new Set([...Object.keys(this.records), ...this.conversations.keys()]);
    return [...keys].map((key) => {
      const conversation = this.conversations.get(key);
      const record = conversation ? conversation.record : this.records[key];
      if (!record) return void 0;
      const [channelId, root] = key.split("/");
      return {
        key,
        channelId,
        ...root ? { root } : {},
        ...record.whole ? { whole: true } : {},
        ...record.where ? { where: record.where } : {},
        at: Math.max(record.at ?? 0, conversation?.used ?? 0),
        ...conversation?.live || conversation?.busy ? { status: conversation.busy ? "Working" : "Idle" } : {}
      };
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  // --- shared with conversations
  opened(conversation) {
    this.runtime.opened(conversation);
  }
  closed(conversation) {
    this.runtime.closed(conversation);
  }
  makeRoom(conversation) {
    return this.runtime.makeRoom(conversation);
  }
  changed() {
    this.runtime.notify();
  }
  recordUsage(details) {
    return this.runtime.usage.add(this.key, details).catch(() => {
    });
  }
  modelLabel(id) {
    return this.runtime.catalog.snapshot().models.find((model) => model.id === id)?.label ?? id;
  }
  /** Tells the owner a turn failed, where the message was. */
  async report(item, error) {
    if (this.disposed) return;
    await this.kit.reply(item.delivery.agent, item.conversation, `${TITLE} could not finish: ${error}`, { notifyOwner: true }).catch((reason) => console.warn("gemini-acp: could not report a failed turn", reason));
  }
  // --- standalone turns
  /** A watch's or timer's turn, in a one-off session that joins no
   * conversation and is let go of after. */
  async runOnce({ delivery, signal, prompt, key }) {
    const settings = readConfig(delivery.config);
    const agentHandle = delivery.agent;
    let connection;
    let mcp;
    let sessionId;
    let unsubscribe;
    this.starting += 1;
    try {
      connection = await this.connect(agentHandle, settings);
      const cwd = await this.workspace(settings);
      if (signal.aborted) return { ok: false, error: "The turn was stopped before it started" };
      mcp = await this.host.serveMcp(this.tools(agentHandle, void 0, cwd));
      const system = await this.kit.systemPrompt(delivery, { scope: settings.scope, cwd, instructions: settings.instructions });
      const created = await connection.request("session/new", sessionParams(cwd, mcp), SESSION_TIMEOUT_MS);
      sessionId = created.sessionId;
      this.standalone.set(sessionId, settings.mode);
      this.starting -= 1;
      let last = "";
      unsubscribe = connection.onSession(sessionId, (update) => {
        const step = stepOf(update);
        const label = step && `${step.tool}\0${step.target ?? ""}`;
        if (!step || label === last) return;
        last = label;
        delivery.step?.(step.tool, step.target);
      });
      const state = await applySettings(connection, sessionId, sessionState(created), wantedSettings(delivery, settings, this.defaults));
      const text = await prompt();
      if (text === void 0) return { ok: true };
      if (signal.aborted) return { ok: false, error: "The turn was stopped before it started" };
      const cancel = () => connection.notify("session/cancel", { sessionId });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const answer = await connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: `${system}

${this.kit.standalonePrompt(agentHandle, text)}` }]
        });
        void this.recordUsage({ sessionId, wake: key, observations: observationsOf(answer, state.model) });
        const outcome = outcomeOf(answer?.stopReason);
        return outcome.stopped ? { ok: false, error: "The turn was stopped" } : { ok: outcome.ok, ...outcome.error && { error: outcome.error } };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (!this.standalone.delete(sessionId)) this.starting -= 1;
      unsubscribe?.();
      void mcp?.close().catch(() => {
      });
      this.idle();
    }
  }
  /** The agent was removed here, or the plugin is unloading. */
  dispose() {
    this.disposed = true;
    for (const conversation of this.conversations.values()) conversation.dispose();
    void this.connection?.stop();
    this.connection = void 0;
  }
};

// src/runtime/catalog.js
var CHECKING = Object.freeze({ readiness: "checking", models: [], loading: true });
var SIGN_IN = "Sign in to Gemini";
var SIGN_IN_HOW = "Sign in with the Google account of your Gemini subscription, or run gemini in a terminal and choose Sign in with Google, then check again.";
var ACCOUNTS = "~/.gemini";
var AUTH_URL = /https:\/\/accounts\.google\.com\/\S+/;
var Catalog = class {
  constructor(host, notify) {
    this.host = host;
    this.notify = notify;
    this.state = CHECKING;
    this.reading = void 0;
    this.signingIn = void 0;
    this.started = false;
  }
  snapshot = () => this.state;
  set(change) {
    this.state = Object.freeze({ ...this.state, ...change });
    this.notify();
  }
  /** Reads the catalog the first time anyone asks for it. */
  ensure() {
    if (!this.started) void this.check();
    return this.reading ?? Promise.resolve(this.state);
  }
  /** Reads it again; one read runs at a time. */
  check() {
    this.started = true;
    if (this.reading) return this.reading;
    if (!this.state.loading) this.set({ readiness: "checking", loading: true });
    this.reading = this.read().then(
      (found) => found,
      (error) => ({
        readiness: "attention",
        attentionLabel: `Set up ${TITLE}`,
        attentionDescription: errorText(error),
        error: errorText(error),
        models: []
      })
    ).then((state) => {
      this.state = Object.freeze({ ...state, loading: false, signingIn: Boolean(this.signingIn) });
      this.reading = void 0;
      this.notify();
      return this.state;
    });
    return this.reading;
  }
  /** The models, waiting for a read only when there are none yet. */
  async models() {
    const state = this.state.models.length ? this.state : await this.ensure();
    if (!state.models.length) throw new Error(state.error ?? `${TITLE} offered no models`);
    return state.models;
  }
  async read() {
    const cwd = await this.host.resolveDirectory(DEFAULTS.workspace);
    const connection = await AcpConnection.start(this.host, { cwd });
    try {
      let created;
      try {
        created = await connection.request("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
      } catch (error) {
        if (connection.closed || !needsSignIn(error)) throw error;
        return {
          readiness: "attention",
          attentionLabel: SIGN_IN,
          attentionDescription: SIGN_IN_HOW,
          error: `${SIGN_IN} to choose a model.`,
          canSignIn: connection.offersGoogleLogin,
          models: []
        };
      }
      const models = modelsOf(created).choices.map((choice) => ({
        id: choice.value,
        label: choice.name,
        description: choice.description,
        // Gemini CLI's ACP mode lets a client pick no thinking level: each
        // model thinks as Gemini sets it up.
        efforts: []
      }));
      return { readiness: "ready", account: await this.account(), models, default: modelsOf(created).current };
    } finally {
      void connection.stop();
    }
  }
  /** The signed-in Google account, as Gemini CLI saved it, if it says. */
  async account() {
    try {
      const folder = await this.host.resolveDirectory(ACCOUNTS);
      const bytes = await this.host.readFile("google_accounts.json", { cwd: folder });
      const active = JSON.parse(new TextDecoder().decode(bytes))?.active;
      return typeof active === "string" && active ? active : void 0;
    } catch {
      return void 0;
    }
  }
  /** Signs in with a Google account in the browser, as `gemini` does, then
   * reads the catalog again. Gemini CLI saves the sign-in for every later
   * start, the terminal's included. */
  signIn() {
    if (this.signingIn) return this.signingIn;
    this.set({ signingIn: true, signInError: void 0, signInUrl: void 0 });
    this.signingIn = (async () => {
      let connection;
      try {
        const cwd = await this.host.resolveDirectory(DEFAULTS.workspace);
        connection = await AcpConnection.start(this.host, {
          cwd,
          // The page to open, should the browser not open by itself.
          onStderr: () => {
            const url = AUTH_URL.exec(connection?.stderr ?? "")?.[0];
            if (url && url !== this.state.signInUrl) this.set({ signInUrl: url });
          }
        });
        if (!connection.offersGoogleLogin) throw new Error(`This Gemini CLI does not offer sign-in with Google.`);
        await connection.request("authenticate", { methodId: GOOGLE_LOGIN }, SIGN_IN_TIMEOUT_MS);
        this.set({ signInUrl: void 0 });
      } catch (error) {
        this.set({ signInError: errorText(error) });
      } finally {
        void connection?.stop();
        this.signingIn = void 0;
        this.set({ signingIn: false });
      }
      return this.check();
    })();
    return this.signingIn;
  }
};

// src/runtime/defaults.js
var VERSION = 1;
var NONE = Object.freeze({ model: "", effort: "" });
var DeviceDefaults = class {
  constructor(store, key, notify) {
    this.store = store;
    this.key = key;
    this.notify = notify;
    this.current = NONE;
    this.loaded = this.load();
  }
  async load() {
    try {
      const value = JSON.parse(await this.store.read(this.key) ?? "null");
      if (value?.version === VERSION && typeof value.model === "string") {
        this.current = Object.freeze({ model: value.model, effort: typeof value.effort === "string" ? value.effort : "" });
        this.notify();
      }
    } catch {
    }
  }
  snapshot = () => this.current;
  /** Settles once saved; only then are the new defaults used. */
  async save({ model = "", effort = "" }) {
    await this.store.set(this.key, JSON.stringify({ version: VERSION, model, effort }));
    this.current = Object.freeze({ model, effort });
    this.notify();
  }
  /** The model and effort a turn runs with: the agent's own, else this
   * device's default, else Gemini's own. A default effort follows only the
   * default model it was chosen for. */
  effective(settings) {
    const { model, effort } = this.current;
    return {
      model: settings.model || model || "default",
      effort: settings.effort || (!settings.model || settings.model === model ? effort : "") || "default"
    };
  }
};

// src/runtime/records.js
var VERSION2 = 1;
var valid = (record) => typeof record?.sessionId === "string" && record.sessionId.length > 0;
var newestFirst = (records) => Object.entries(records).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, SAVED_CONVERSATIONS);
var SessionRecords = class {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    this.writes = /* @__PURE__ */ new Map();
  }
  ownKey(agentKey) {
    return `${this.typeKey}/${agentKey}`;
  }
  /** The agent's saved sessions by conversation key. */
  async load(agentKey) {
    let own;
    try {
      own = JSON.parse(await this.store.read(this.ownKey(agentKey)) ?? "null");
    } catch {
      own = void 0;
    }
    const records = {};
    if (own?.v === VERSION2 && own.conversations && typeof own.conversations === "object") {
      for (const [key, record] of Object.entries(own.conversations)) if (valid(record)) records[key] = record;
    }
    return records;
  }
  /** Saves `records`. Saves for one agent run one at a time; one asked for
   * while another runs is made once after it, with the latest records. */
  save(agentKey, records) {
    let write = this.writes.get(agentKey);
    if (!write) {
      write = { running: void 0, owed: void 0 };
      this.writes.set(agentKey, write);
    }
    write.owed = records;
    if (!write.running)
      write.running = (async () => {
        while (write.owed) {
          const next = write.owed;
          write.owed = void 0;
          await this.write(agentKey, next).catch((error) => console.warn("gemini-acp: could not save sessions", error));
        }
        write.running = void 0;
      })();
    return write.running;
  }
  async write(agentKey, records) {
    const kept = newestFirst(Object.fromEntries(Object.entries(records).filter(([, record]) => valid(record))));
    await this.store.set(this.ownKey(agentKey), JSON.stringify({ v: VERSION2, conversations: Object.fromEntries(kept) }));
  }
  /** Resolves once every save asked for so far has been written. */
  async flush() {
    await Promise.all([...this.writes.values()].map((write) => write.running));
  }
};

// src/runtime/transcript.js
var VERSION3 = 1;
var TEXT_LIMIT = 2e4;
var OUTPUT_LIMIT = 4e3;
var ITEM_LIMIT = 400;
var SAVE_MS = 2e3;
var EVENT_ID2 = /^[0-9a-f]{64}$/;
var clip = (text, limit = TEXT_LIMIT) => typeof text !== "string" ? "" : text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text;
function contentOf(content) {
  const texts = [];
  const diffs = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "content" && part.content?.type === "text") texts.push(part.content.text);
    if (part?.type === "diff" && typeof part.path === "string")
      diffs.push({
        path: part.path,
        ...typeof part.oldText === "string" && part.oldText ? { oldText: clip(part.oldText) } : {},
        newText: clip(part.newText ?? "")
      });
  }
  return { text: texts.join("\n"), diffs };
}
function askedBy(delivery, promptText) {
  const trigger = delivery?.trigger ?? {};
  const event = trigger.event;
  if (typeof event?.content === "string")
    return { text: event.content, ...typeof event.pubkey === "string" ? { authorPubkey: event.pubkey } : {} };
  if (typeof trigger.text === "string") return { text: trigger.text };
  const section = promptSections(promptText).find((item) => item.tag === "buzz-event" || item.tag === "text");
  return { text: clip(section?.body ?? "", 2e3) };
}
function eventsOf(delivery) {
  const trigger = delivery?.trigger ?? {};
  const ids = [trigger.event?.id, ...Array.isArray(trigger.events) ? trigger.events.map((item) => item?.event?.id ?? item?.id) : []];
  return ids.filter((id) => typeof id === "string" && EVENT_ID2.test(id));
}
var TranscriptStore = class {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    this.held = /* @__PURE__ */ new Map();
    this.timers = /* @__PURE__ */ new Map();
  }
  key(agentKey, conversationKey) {
    return `${this.typeKey}.transcript.v${VERSION3}:${agentKey}:${conversationKey}`;
  }
  /** A conversation's turns, oldest first. */
  async read(agentKey, conversationKey) {
    const key = this.key(agentKey, conversationKey);
    let held = this.held.get(key);
    if (!held) {
      let turns = [];
      try {
        const saved = JSON.parse(await this.store.read(key) ?? "null");
        if (saved?.v === VERSION3 && Array.isArray(saved.turns)) turns = saved.turns;
      } catch {
      }
      held = this.held.get(key) ?? { turns };
      this.held.set(key, held);
    }
    return held;
  }
  /** Starts recording a turn. Returns its recorder. */
  async begin(agentKey, conversationKey, details) {
    await this.read(agentKey, conversationKey);
    const key = this.key(agentKey, conversationKey);
    const turn = new TurnRecord(details, (value) => this.changed(key, value));
    const held = this.held.get(key);
    this.held.set(key, { turns: [...held.turns, turn.value].slice(-TRANSCRIPT_TURNS) });
    this.changed(key, turn.value);
    return turn;
  }
  /** A turn's new `value`: it replaces the one held, and is saved soon. */
  changed(key, value) {
    const held = this.held.get(key);
    if (held)
      this.held.set(key, { turns: held.turns.map((turn) => turn.turnId === value.turnId ? value : turn) });
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.save(key);
      }, SAVE_MS)
    );
  }
  async save(key) {
    const held = this.held.get(key);
    if (!held) return;
    await this.store.set(key, JSON.stringify({ v: VERSION3, turns: held.turns })).catch((error) => console.warn("gemini-acp: could not save a transcript", error));
  }
  /** Forgets a conversation's transcript. */
  async forget(agentKey, conversationKey) {
    const key = this.key(agentKey, conversationKey);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.held.delete(key);
    await this.store.set(key, null).catch(() => {
    });
  }
  /** Saves every transcript with a change still waiting. */
  async flush() {
    const keys = [...this.timers.keys()];
    for (const key of keys) clearTimeout(this.timers.get(key));
    this.timers.clear();
    await Promise.all(keys.map((key) => this.save(key)));
  }
};
var TurnRecord = class {
  constructor({ sessionId, newSession, channelId, root, delivery, system, prompt, config = [] }, changed) {
    const at = Date.now();
    this.changed = changed;
    this.next = 0;
    this.tools = /* @__PURE__ */ new Map();
    this.open = void 0;
    this.value = {
      turnId: `${sessionId}:${at}:${Math.random().toString(36).slice(2, 8)}`,
      channelId: channelId ?? null,
      threadRootId: root ?? null,
      triggeringEventIds: eventsOf(delivery),
      sessionId,
      newSession: Boolean(newSession),
      config,
      startedAt: at,
      partial: false,
      items: []
    };
    if (system) this.add({ type: "system", sections: promptSections(system) });
    if (prompt !== void 0)
      this.add({ type: "prompt", ...askedBy(delivery, prompt), sections: promptSections(prompt), steer: false });
  }
  add(item) {
    if (this.value.items.length >= ITEM_LIMIT) return void 0;
    const full = { id: `i${++this.next}`, at: Date.now(), ...item };
    this.value = { ...this.value, items: [...this.value.items, full] };
    this.open = void 0;
    this.changed(this.value);
    return full.id;
  }
  replace(id, change) {
    const items = this.value.items.map((item) => item.id === id ? { ...item, ...change(item) } : item);
    this.value = { ...this.value, items };
    this.changed(this.value);
  }
  /** A `session/update` of this turn. */
  update(update) {
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = update.content?.type === "text" ? update.content.text : "";
        if (!text || modeNote(update)) return;
        const type = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
        if (update._meta?.reset && this.open?.type === type) this.replace(this.open.id, () => ({ text: "" }));
        if (this.open?.type === type) {
          const { id } = this.open;
          this.replace(id, (item) => ({ text: clip(item.text + text) }));
          this.open = { id, type };
        } else {
          const id = this.add({ type, text: clip(text) });
          if (id) this.open = { id, type };
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (buzzToolMessage(update)) return;
        const { text, diffs } = contentOf(update.content);
        const paths = Array.isArray(update.locations) ? update.locations.map((location) => location?.path).filter((path) => typeof path === "string") : void 0;
        const status = typeof update.status === "string" ? update.status : void 0;
        const ended = status === "completed" || status === "failed";
        const known = this.tools.get(callId);
        if (!known) {
          const name = toolNameOf(update);
          const id = this.add({
            type: "tool",
            toolCallId: callId,
            title: clip(typeof update.title === "string" && update.title ? update.title : name ?? "Tool", 400),
            kind: typeof update.kind === "string" ? update.kind : "other",
            status: status ?? "in_progress",
            input: name && buzzToolOf(name) ? `buzz ${buzzToolOf(name)}` : name ?? "",
            output: clip(text, OUTPUT_LIMIT),
            diffs,
            paths: paths ?? [],
            ...ended ? { completedAt: Date.now() } : {},
            truncated: false
          });
          if (id) this.tools.set(callId, id);
          return;
        }
        this.replace(known, (item) => ({
          ...status ? { status } : {},
          ...typeof update.title === "string" && update.title ? { title: clip(update.title, 400) } : {},
          ...text ? { output: clip(text, OUTPUT_LIMIT) } : {},
          ...diffs.length ? { diffs } : {},
          ...paths?.length ? { paths } : {},
          ...ended && !item.completedAt ? { completedAt: Date.now() } : {}
        }));
        this.open = void 0;
        return;
      }
      case "plan": {
        const entries = (Array.isArray(update.entries) ? update.entries : []).filter((entry) => typeof entry?.content === "string").map((entry) => ({ content: clip(entry.content, 2e3), status: String(entry.status ?? "pending") }));
        if (entries.length) this.add({ type: "plan", entries });
        return;
      }
      case "usage_update":
        if (typeof update.used === "number" && typeof update.size === "number") {
          this.value = { ...this.value, context: { used: update.used, size: update.size } };
          this.changed(this.value);
        }
        return;
      default:
    }
  }
  /** A message the agent posted to Buzz with one of its message tools. */
  posted(text, messageId) {
    if (typeof text !== "string" || !text) return;
    this.add({ type: "message", text: clip(text), posted: true, ...messageId ? { messageId } : {} });
  }
  status(text) {
    this.add({ type: "status", text });
  }
  /** The turn ended: `outcome` is `ended`, `stopped` or `error`. */
  end({ outcome, error, stopReason }) {
    if (this.value.endedAt) return;
    this.value = {
      ...this.value,
      endedAt: Date.now(),
      outcome,
      ...error ? { error: clip(error, 2e3) } : {},
      ...stopReason ? { stopReason } : {},
      // Tools still running when the turn ended did not finish.
      items: this.value.items.map(
        (item) => item.type === "tool" && (item.status === "in_progress" || item.status === "pending") ? { ...item, status: outcome === "stopped" ? "cancelled" : "failed" } : item
      )
    };
    this.changed(this.value);
  }
};
function buzzToolMessage(update) {
  const tool = buzzToolOf(toolNameOf(update));
  return tool === "send" || tool === "reply_in_subthread";
}

// src/runtime/usage.js
var VERSION4 = 1;
var UsageBook = class {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    this.held = /* @__PURE__ */ new Map();
    this.writes = /* @__PURE__ */ new Map();
  }
  key(agentKey) {
    return `${this.typeKey}.usage.v${VERSION4}:${agentKey}`;
  }
  async load(agentKey) {
    let held = this.held.get(agentKey);
    if (held) return held;
    let sessions = {};
    try {
      const saved = JSON.parse(await this.store.read(this.key(agentKey)) ?? "null");
      if (saved?.v === VERSION4 && saved.sessions && typeof saved.sessions === "object") sessions = saved.sessions;
    } catch {
    }
    held = this.held.get(agentKey) ?? sessions;
    this.held.set(agentKey, held);
    return held;
  }
  /** Adds a turn's `observations` to session `sessionId`, where it started. */
  async add(agentKey, { sessionId, channelId, root, wake, observations }) {
    if (!sessionId || !observations?.length) return;
    const sessions = await this.load(agentKey);
    const now = Date.now();
    const prior = sessions[sessionId];
    sessions[sessionId] = {
      ...prior ?? { startedAt: observations[0].at ?? now },
      ...channelId && !prior?.channelId ? { channelId } : {},
      ...root && !prior?.root ? { root } : {},
      ...wake && !prior?.wake ? { wake } : {},
      lastAt: now,
      observations: [...prior?.observations ?? [], ...observations].slice(-USAGE_OBSERVATIONS)
    };
    const kept = Object.entries(sessions).sort(([, a], [, b]) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, USAGE_SESSIONS);
    const next = Object.fromEntries(kept);
    this.held.set(agentKey, next);
    await this.save(agentKey);
  }
  save(agentKey) {
    const prior = this.writes.get(agentKey) ?? Promise.resolve();
    const write = prior.then(() => this.store.set(this.key(agentKey), JSON.stringify({ v: VERSION4, sessions: this.held.get(agentKey) ?? {} }))).catch((error) => console.warn("gemini-acp: could not save usage", error));
    this.writes.set(agentKey, write);
    return write;
  }
  /** The agent's sessions with activity since `since`, as Buzz reads usage. */
  async read(agentKey, { since = 0, signal } = {}) {
    signal?.throwIfAborted?.();
    const sessions = await this.load(agentKey);
    signal?.throwIfAborted?.();
    return Object.entries(sessions).filter(([, session]) => (session.lastAt ?? 0) >= since).map(([id, session]) => ({
      id,
      revision: `${session.observations.length}:${session.lastAt}`,
      gaps: [],
      ...session.channelId ? { channelId: session.channelId } : {},
      ...session.root ? { root: session.root } : {},
      ...session.wake ? { wake: session.wake } : {},
      startedAt: session.startedAt,
      lastAt: session.lastAt,
      observations: session.observations
    }));
  }
};

// src/runtime/runtime.js
var Runtime = class {
  constructor({ agents, host, typeKey }) {
    this.agentsService = agents;
    this.kit = agents.harness;
    this.host = host;
    this.typeKey = typeKey;
    this.listeners = /* @__PURE__ */ new Set();
    this.agents = /* @__PURE__ */ new Map();
    this.live = /* @__PURE__ */ new Set();
    this.sessionLists = /* @__PURE__ */ new Map();
    this.rowLists = /* @__PURE__ */ new Map();
    this.records = new SessionRecords(agents.storage, typeKey);
    this.defaults = new DeviceDefaults(agents.storage, `${typeKey}.provider-defaults.v1`, () => this.notify());
    this.catalog = new Catalog(host, () => this.notify());
    this.transcripts = new TranscriptStore(agents.storage, typeKey);
    this.usage = new UsageBook(agents.storage, typeKey);
  }
  agent(key) {
    let agent = this.agents.get(key);
    if (!agent || agent.disposed) {
      agent = new AgentRuntime(this, key);
      this.agents.set(key, agent);
    }
    return agent;
  }
  // --- turns
  async run(delivery) {
    const settings = readConfig(delivery.config);
    const conversation = await this.kit.conversation(delivery, settings.scope);
    if (!conversation) return delivery.ignored?.();
    const agent = this.agent(delivery.agent.key);
    const target = await agent.conversation(conversation.key);
    await target.deliver(delivery, conversation, settings);
  }
  runOnce(turn) {
    return this.agent(turn.delivery.agent.key).runOnce(turn);
  }
  // --- session controls
  scope = (agent) => readConfig(agent.config).scope;
  sessionState(agent, place) {
    return this.agents.get(agent.key)?.conversationAt(place, this.scope(agent))?.controlState ?? "idle";
  }
  async control(agent, place, action, reset) {
    const owner = this.agent(agent.key);
    await owner.loaded;
    const scope = this.scope(agent);
    const conversation = owner.conversationAt(place, scope) ?? await owner.conversation(owner.savedKeyAt(place, scope));
    if (action === "interrupt") return conversation.interrupt();
    if (action === "compact") return conversation.compact();
    if (action === "new") return reset ? reset(() => conversation.reset()) : conversation.reset();
  }
  // --- open sessions
  opened(conversation) {
    this.live.delete(conversation);
    this.live.add(conversation);
  }
  closed(conversation) {
    this.live.delete(conversation);
  }
  /** Closes least recently used idle sessions until one more may open. */
  async makeRoom(opening) {
    while (this.live.size >= MAX_LIVE_SESSIONS) {
      const idle = [...this.live].find((conversation) => conversation !== opening && !conversation.busy);
      if (!idle) return;
      void idle.close();
    }
  }
  // --- views
  /** Stable until something changes, as Buzz's views read it. */
  sessionList(key) {
    let list = this.sessionLists.get(key);
    if (!list) {
      list = this.agent(key).sessions();
      this.sessionLists.set(key, list);
    }
    return list;
  }
  /** A conversation's transcript, as Buzz's transcript view reads it. */
  transcript(agentKey, conversationKey) {
    return this.transcripts.read(agentKey, conversationKey);
  }
  /** Whether a conversation of the agent is running a turn now. */
  working(agentKey, conversationKey) {
    return Boolean(this.agents.get(agentKey)?.conversations.get(conversationKey)?.busy);
  }
  /** Stable until something changes, as the Activity tab reads it. */
  conversationRows(key) {
    let rows = this.rowLists.get(key);
    if (!rows) {
      rows = this.agent(key).rows();
      this.rowLists.set(key, rows);
    }
    return rows;
  }
  async models(agent) {
    const models = await this.catalog.models();
    return {
      current: this.defaults.effective(readConfig(agent.config)).model,
      models: models.map(({ id, label, efforts, effort }) => ({ id, label, efforts, ...effort && { effort } }))
    };
  }
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  notify() {
    this.sessionLists.clear();
    this.rowLists.clear();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.warn("gemini-acp: a listener failed", error);
      }
    }
  }
  // --- lifecycle
  /** Stops agents of this type that no longer run here. */
  sync() {
    const running = new Set(
      this.agentsService.snapshot().running.filter((agent) => agent.type === this.typeKey).map((agent) => agent.key)
    );
    for (const [key, agent] of this.agents) {
      if (running.has(key)) continue;
      this.agents.delete(key);
      agent.dispose();
    }
  }
  dispose() {
    void this.transcripts.flush();
    for (const agent of this.agents.values()) agent.dispose();
    this.agents.clear();
    this.live.clear();
  }
};

// src/assets/gemini-logo.svg
var gemini_logo_default = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">%0A  <defs><linearGradient id="gm-fill" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="%234C8DF6"/><stop offset="0.55" stop-color="%237C6CF2"/><stop offset="1" stop-color="%23A86CE4"/></linearGradient></defs>%0A  <path d="M16 2 C17.96 14.04 17.96 14.04 30 16 C17.96 17.96 17.96 17.96 16 30 C14.04 17.96 14.04 17.96 2 16 C14.04 14.04 14.04 14.04 16 2 Z" fill="url(%23gm-fill)"/>%0A</svg>';

// src/assets/harness-mark.svg
var harness_mark_default = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">%0A  <defs>%0A    <linearGradient id="gh-fill" x1="1" y1="1" x2="27" y2="27" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="%234C8DF6"/><stop offset="0.55" stop-color="%237C6CF2"/><stop offset="1" stop-color="%23A86CE4"/></linearGradient>%0A    <mask id="gh-cut"><rect width="32" height="32" fill="%23fff"/><circle cx="25.3" cy="25.3" r="7.15" fill="%23000"/></mask>%0A  </defs>%0A  <path d="M14.2 0.8 C16.076 12.324 16.076 12.324 27.6 14.2 C16.076 16.076 16.076 16.076 14.2 27.6 C12.324 16.076 12.324 16.076 0.8 14.2 C12.324 12.324 12.324 12.324 14.2 0.8 Z" fill="url(%23gh-fill)" mask="url(%23gh-cut)"/>%0A  <circle cx="25.3" cy="25.3" r="5.9" fill="%236A5BE8"/>%0A  <g transform="translate(25.3 25.3)"><path d="M0 -2.85 V2.85 M-2.85 0 H2.85" stroke="%23F5F3FF" stroke-width="1.6" stroke-linecap="round"/></g>%0A</svg>';

// src/ui/react.js
var React;
function bindReact(react) {
  React = react;
}
var h = (...args) => React.createElement(...args);
function Fragment(props) {
  return React.createElement(React.Fragment, null, props.children);
}
var useEffect = (...args) => React.useEffect(...args);
var useId = () => React.useId();
var useLayoutEffect = (...args) => React.useLayoutEffect(...args);
var useRef = (initial) => React.useRef(initial);
var useState = (initial) => React.useState(initial);
var useSyncExternalStore = (subscribe2, snapshot) => React.useSyncExternalStore(subscribe2, snapshot, snapshot);

// src/ui/icons.jsx
var rem = (size) => typeof size === "number" ? `${size / 16}rem` : size;
function Tabler({ size = 16, className, paths }) {
  return /* @__PURE__ */ h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: rem(size),
      height: rem(size),
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: ["tabler-icon", className].filter(Boolean).join(" "),
      "aria-hidden": "true"
    },
    /* @__PURE__ */ h("path", { stroke: "none", d: "M0 0h24v24H0z", fill: "none" }),
    paths.map((d) => /* @__PURE__ */ h("path", { key: d, d }))
  );
}
var CaretDownIcon = (props) => /* @__PURE__ */ h(Tabler, { ...props, paths: ["M6 9l6 6l6 -6"] });
var CheckIcon = (props) => /* @__PURE__ */ h(Tabler, { ...props, paths: ["M5 12l5 5l10 -10"] });
var SpinnerIcon = (props) => /* @__PURE__ */ h(Tabler, { ...props, paths: ["M12 3a9 9 0 1 0 9 9"] });
function picture(href) {
  return function Picture({ size = 20, className }) {
    return /* @__PURE__ */ h("svg", { width: rem(size), height: rem(size), viewBox: "0 0 32 32", xmlns: "http://www.w3.org/2000/svg", className, "aria-hidden": "true" }, /* @__PURE__ */ h("image", { href, width: "32", height: "32" }));
  };
}
var GeminiLogoIcon = picture(gemini_logo_default);
var HarnessIcon = picture(harness_mark_default);

// src/ui/controls.jsx
function Button({
  variant = "subtle",
  size = "md",
  shape = "capsule",
  type = "button",
  loading = false,
  disabled = false,
  onClick,
  children,
  ...props
}) {
  const inert = disabled || loading;
  return /* @__PURE__ */ h(
    "button",
    {
      ...props,
      type,
      disabled: disabled && !loading,
      "aria-disabled": inert || void 0,
      "aria-busy": loading || void 0,
      "data-disabled": inert ? "" : void 0,
      "data-buzz-ui": "",
      className: "buzz-button",
      "data-variant": variant,
      "data-size": size,
      "data-button-shape": shape,
      "data-loading": loading || void 0,
      onClick: (event) => {
        if (inert) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }
    },
    /* @__PURE__ */ h("span", { className: "buzz-button-label" }, children),
    loading && /* @__PURE__ */ h(SpinnerIcon, { size: 18, className: "buzz-button-spinner" })
  );
}
var SettingsGroup = ({ children, layout = "rows" }) => /* @__PURE__ */ h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": layout }, children);
function PreferenceRow({ title, subtitle, trailing }) {
  return /* @__PURE__ */ h("div", { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" }, /* @__PURE__ */ h("div", { className: "buzz-preference-row-content" }, /* @__PURE__ */ h("div", { className: "buzz-preference-row-label" }, title), subtitle && /* @__PURE__ */ h("span", { className: "buzz-preference-row-description" }, subtitle)), trailing != null && /* @__PURE__ */ h("div", { className: "buzz-preference-row-trailing" }, trailing));
}
function Field({ label, description, optional = false, children }) {
  const id = useId();
  const describedBy = description ? `${id}-description` : void 0;
  return /* @__PURE__ */ h("div", { "data-buzz-ui": "", className: "buzz-field" }, /* @__PURE__ */ h("label", { className: "buzz-field-label", htmlFor: id }, label, optional && /* @__PURE__ */ h(Fragment, null, " ", /* @__PURE__ */ h("span", { className: "buzz-field-optional" }, "Optional"))), children({ id, "aria-describedby": describedBy }), description && /* @__PURE__ */ h("p", { id: describedBy, className: "buzz-field-description" }, description));
}
function Input({ value, onValueChange, ...props }) {
  return /* @__PURE__ */ h(
    "input",
    {
      ...props,
      "data-buzz-ui": "",
      "data-size": "md",
      className: "buzz-input",
      value,
      onChange: (event) => onValueChange(event.target.value)
    }
  );
}
var EXAMPLE = "Help me plan my week and prioritize tasks.";
function AgentInstructions({ value, disabled, onChange, creation = false }) {
  return /* @__PURE__ */ h(Field, { label: "Instructions", optional: creation }, (control) => /* @__PURE__ */ h(
    "textarea",
    {
      ...control,
      "data-buzz-ui": "",
      className: "buzz-textarea",
      "data-variant": "text",
      "data-surface": "inset",
      "data-appearance": "outlined",
      rows: creation ? 4 : 8,
      value,
      disabled,
      placeholder: EXAMPLE,
      onChange: (event) => onChange(event.target.value)
    }
  ));
}
function SaveButton({ form, saving, visible, disabled = false }) {
  if (!visible && !saving) return null;
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(Button, { type: "submit", form, variant: "prominent", loading: saving, disabled }, saving ? "Saving\u2026" : "Save"));
}
var stack = (gap = "var(--space-4)") => ({ display: "grid", gap, minWidth: 0 });
var row = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", maxWidth: "100%" };

// src/ui/services.js
var services = { runtime: void 0, agents: void 0, openSetup: void 0 };
function bindServices(next) {
  Object.assign(services, next);
}

// src/ui/activity.jsx
var RECENT_LIMIT = 20;
var styles = {
  activity: { display: "flex", flexDirection: "column", minWidth: 0, gap: "var(--space-6)" },
  section: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--space-2)", minWidth: 0, overflowWrap: "anywhere" },
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none", minWidth: 0 },
  entry: (first, last) => ({
    display: "grid",
    gap: "var(--space-2)",
    paddingBlock: "var(--space-4)",
    ...first ? { paddingBlockStart: 0 } : {},
    ...last ? { paddingBlockEnd: 0 } : { borderBottom: "1px solid var(--border-standard)" }
  }),
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)", minWidth: 0 },
  copy: { flex: "1 1 12rem", minWidth: 0, overflowWrap: "anywhere" },
  name: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
};
var when = (at) => at ? new Date(at).toLocaleString(void 0, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
var nameOf = (row2) => row2.where || (row2.root ? `Thread ${row2.root.slice(0, 8)}` : `Channel ${row2.channelId.slice(0, 8)}`);
function Header({ id, title, actions }) {
  return /* @__PURE__ */ h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" }, /* @__PURE__ */ h("div", { className: "buzz-content-header-copy" }, /* @__PURE__ */ h("h3", { id, className: "buzz-content-header-title" }, title)), actions && /* @__PURE__ */ h("div", { className: "buzz-content-header-actions" }, actions));
}
function Row({ row: row2, detail, onView }) {
  return /* @__PURE__ */ h("div", { style: styles.row }, /* @__PURE__ */ h("span", { style: styles.copy }, /* @__PURE__ */ h("span", { className: "text-label-sm", style: styles.name, title: nameOf(row2) }, nameOf(row2)), /* @__PURE__ */ h("span", { className: "text-body-sm text-subtle", style: { display: "block" } }, detail)), /* @__PURE__ */ h(Button, { variant: "subtle", size: "sm", "aria-label": `View transcript: ${nameOf(row2)}`, onClick: onView }, "View transcript"));
}
function Opened({ conversation, row: row2, onView }) {
  const id = useId();
  const place = (row2 ? row2.root : conversation.rootId) ? "thread" : "channel";
  return /* @__PURE__ */ h("section", { "aria-labelledby": id, style: styles.section }, /* @__PURE__ */ h(Header, { id, title: `This ${place}` }), /* @__PURE__ */ h(SettingsGroup, { layout: "form" }, /* @__PURE__ */ h("div", { style: { display: "grid", gap: "var(--space-2)" } }, row2 ? /* @__PURE__ */ h(
    Row,
    {
      row: row2,
      detail: [row2.status, row2.at && `Last active ${when(row2.at)}`].filter(Boolean).join(" \xB7 ") || "Gemini session",
      onView
    }
  ) : /* @__PURE__ */ h("span", { style: { display: "grid", gap: "var(--space-1)" } }, /* @__PURE__ */ h("span", { className: "text-label" }, "No Gemini session here yet"), /* @__PURE__ */ h("span", { className: "text-body-sm text-subtle" }, "One starts when you mention the agent in this ", place, ".")))));
}
function TranscriptView({ agent, row: row2, working, onBack }) {
  const Transcript = services.agents?.ui?.Transcript;
  const id = useId();
  return /* @__PURE__ */ h("section", { "aria-labelledby": id, style: styles.section }, /* @__PURE__ */ h("div", { style: styles.row }, /* @__PURE__ */ h(Button, { variant: "ghost", size: "sm", onClick: onBack }, "\u2190 Back to profile")), /* @__PURE__ */ h(Header, { id, title: nameOf(row2) }), Transcript ? /* @__PURE__ */ h(
    Transcript,
    {
      agent,
      readKey: `${agent.key}:${row2.key}`,
      read: async () => {
        const { turns } = await services.runtime.transcript(agent.key, row2.key);
        return turns.length ? { turns } : void 0;
      },
      working,
      reading: "Reading the transcript\u2026",
      missing: /* @__PURE__ */ h("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, "No turns recorded for this conversation on this device yet."),
      failed: "Could not read the Gemini session"
    }
  ) : /* @__PURE__ */ h("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, "Transcripts need a newer Buzz."));
}
function ActivityTab({ agent, conversation, initialTranscript }) {
  const rows = useSyncExternalStore(
    (listener) => services.runtime.subscribe(listener),
    () => services.runtime.conversationRows(agent.key)
  );
  const [open, setOpen] = useState(void 0);
  const here = conversation && (rows.find((row2) => row2.channelId === conversation.channelId && row2.root === conversation.rootId) ?? rows.find((row2) => row2.channelId === conversation.channelId && row2.whole));
  useEffect(() => {
    if (!initialTranscript) return;
    if (here) setOpen(here.key);
    initialTranscript.done();
  }, [initialTranscript?.opening]);
  const shown2 = open && rows.find((row2) => row2.key === open);
  if (shown2)
    return /* @__PURE__ */ h("div", { style: styles.activity }, /* @__PURE__ */ h(TranscriptView, { agent, row: shown2, working: shown2.status === "Working", onBack: () => setOpen(void 0) }));
  const recent = rows.filter((row2) => row2.key !== here?.key).sort((a, b) => Number(b.channelId === conversation?.channelId) - Number(a.channelId === conversation?.channelId)).slice(0, RECENT_LIMIT);
  return /* @__PURE__ */ h("div", { style: styles.activity }, conversation && /* @__PURE__ */ h(Opened, { conversation, row: here, onView: () => here && setOpen(here.key) }), /* @__PURE__ */ h("section", { style: styles.section }, /* @__PURE__ */ h(Header, { title: "Recent conversations" }), /* @__PURE__ */ h(SettingsGroup, { layout: "form" }, /* @__PURE__ */ h("div", null, recent.length ? /* @__PURE__ */ h("ul", { style: styles.list }, recent.map((row2, index) => /* @__PURE__ */ h("li", { key: row2.key, style: styles.entry(index === 0, index === recent.length - 1) }, /* @__PURE__ */ h(
    Row,
    {
      row: row2,
      detail: [row2.root ? `Thread ${row2.root.slice(0, 8)}` : "Channel", row2.status, when(row2.at)].filter(Boolean).join(" \xB7 "),
      onView: () => setOpen(row2.key)
    }
  )))) : /* @__PURE__ */ h("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, "No other conversations saved in this app yet.")))));
}

// src/ui/select.jsx
var GAP = 4;
var EDGE = 8;
var CLOSE_MS = 120;
var TYPEAHEAD_MS = 700;
var LAYER = {
  position: "fixed",
  inset: 0,
  width: "100vw",
  height: "100vh",
  maxWidth: "none",
  maxHeight: "none",
  margin: 0,
  padding: 0,
  border: "none",
  background: "transparent",
  overflow: "visible"
};
function placement(anchor, list, align) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const below = height - anchor.bottom - EDGE;
  const above = anchor.top - EDGE;
  const side = below < 220 && above > below ? "top" : "bottom";
  const listWidth = list?.offsetWidth || anchor.width;
  const start = align === "end" ? anchor.right - listWidth : anchor.left;
  const left = Math.min(Math.max(EDGE, start), Math.max(EDGE, width - EDGE - listWidth));
  return {
    side,
    style: {
      position: "absolute",
      left: `${left}px`,
      ...side === "bottom" ? { top: `${anchor.bottom + GAP}px` } : { bottom: `${height - anchor.top + GAP}px` },
      "--anchor-width": `${anchor.width}px`,
      "--available-height": `${Math.max(120, (side === "bottom" ? below : above) - GAP)}px`,
      "--available-width": `${width - 2 * EDGE}px`,
      "--transform-origin": side === "bottom" ? "top" : "bottom"
    }
  };
}
function Select({
  label,
  value,
  options,
  onValueChange,
  variant = "compact",
  appearance = "outlined",
  size,
  valueLabel,
  valueSuffix,
  valueTitle,
  leading,
  align = "start",
  disabled = false,
  description
}) {
  const id = useId();
  const trigger = useRef(null);
  const layer = useRef(null);
  const list = useRef(null);
  const closing = useRef(void 0);
  const typed = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("closed");
  const [place, setPlace] = useState({ side: "bottom", style: {} });
  const [highlight, setHighlight] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const enabled = (index) => index >= 0 && index < options.length && !options[index].disabled;
  const step = (from, by) => {
    for (let index = from + by; index >= 0 && index < options.length; index += by) if (enabled(index)) return index;
    return from;
  };
  const optionId = (index) => `${id}-option-${index}`;
  const position = () => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (anchor) setPlace(placement(anchor, list.current?.parentElement, align));
  };
  const show = () => {
    if (disabled || open) return;
    clearTimeout(closing.current);
    position();
    try {
      layer.current?.showPopover?.();
    } catch {
    }
    setOpen(true);
    setPhase("starting");
    setHighlight(enabled(selectedIndex) ? selectedIndex : step(-1, 1));
    requestAnimationFrame(() => {
      list.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => setPhase("open"));
    });
  };
  const hide = (returnFocus = true) => {
    if (!open) return;
    setOpen(false);
    setPhase("ending");
    clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      try {
        layer.current?.hidePopover?.();
      } catch {
      }
      setPhase("closed");
    }, CLOSE_MS);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (index) => {
    if (!open || !enabled(index)) return;
    hide();
    if (options[index].value !== value) onValueChange(options[index].value);
  };
  useEffect(() => () => clearTimeout(closing.current), []);
  useEffect(() => {
    if (disabled) hide(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (open) position();
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const move = (event) => {
      if (event.type === "scroll" && list.current?.contains(event.target)) return;
      position();
    };
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    };
  }, [open]);
  useEffect(() => {
    if (open && highlight >= 0) document.getElementById(optionId(highlight))?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlight]);
  const onTriggerKey = (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show();
    }
  };
  const onListKey = (event) => {
    const { key } = event;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === "Escape") {
      handled();
      hide();
    } else if (key === "Tab") hide();
    else if (key === "ArrowDown") {
      handled();
      setHighlight((index) => step(index, 1));
    } else if (key === "ArrowUp") {
      handled();
      setHighlight((index) => step(index, -1));
    } else if (key === "Home") {
      handled();
      setHighlight(step(-1, 1));
    } else if (key === "End") {
      handled();
      setHighlight(step(options.length, -1));
    } else if (key === "Enter" || key === " " && !typed.current.text) {
      handled();
      choose(highlight);
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + key.toLowerCase();
      typed.current = { text, at: now };
      setTimeout(() => {
        if (Date.now() - typed.current.at >= TYPEAHEAD_MS) typed.current = { text: "", at: 0 };
      }, TYPEAHEAD_MS);
      const match = options.findIndex((option, index) => enabled(index) && option.label.toLowerCase().startsWith(text));
      if (match >= 0) setHighlight(match);
    }
  };
  const preference = variant === "preference";
  const control = /* @__PURE__ */ h("div", { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": "compact", "data-appearance": appearance }, /* @__PURE__ */ h("div", { className: "sr-only", id: `${id}-label` }, label), /* @__PURE__ */ h(
    Button,
    {
      ref: trigger,
      shape: preference ? "control" : "capsule",
      variant: appearance === "outlined" ? "outline" : appearance,
      size: size ?? "sm",
      disabled,
      role: "combobox",
      "aria-label": label,
      "aria-haspopup": "listbox",
      "aria-expanded": open,
      "aria-controls": `${id}-list`,
      "data-popup-open": open ? "" : void 0,
      onClick: () => open ? hide() : show(),
      onKeyDown: onTriggerKey
    },
    /* @__PURE__ */ h("span", { className: "buzz-select-value-content" }, leading && /* @__PURE__ */ h("span", { className: "buzz-select-leading", "aria-hidden": "true" }, leading), /* @__PURE__ */ h("span", { className: "buzz-select-value-text" }, /* @__PURE__ */ h("span", { className: "buzz-select-value", title: valueTitle ?? selected?.label }, valueLabel ?? selected?.label ?? ""), valueSuffix && /* @__PURE__ */ h("span", { className: "buzz-select-value-suffix" }, valueSuffix))),
    /* @__PURE__ */ h("span", { "aria-hidden": "true" }, /* @__PURE__ */ h(CaretDownIcon, { size: 14, className: "buzz-dropdown-chevron" }))
  ), /* @__PURE__ */ h(
    "div",
    {
      ref: layer,
      popover: "manual",
      style: { ...LAYER, ...phase === "closed" ? { display: "none" } : {}, pointerEvents: open ? "auto" : "none" },
      onPointerDown: (event) => {
        if (event.target === layer.current) {
          event.preventDefault();
          hide(false);
        }
      }
    },
    /* @__PURE__ */ h(
      "div",
      {
        "data-buzz-ui": "",
        className: "buzz-select-popup text-body",
        "data-variant": "compact",
        "data-side": place.side,
        "data-starting-style": phase === "starting" ? "" : void 0,
        "data-ending-style": phase === "ending" ? "" : void 0,
        style: place.style,
        onKeyDown: onListKey
      },
      /* @__PURE__ */ h(
        "div",
        {
          ref: list,
          role: "listbox",
          id: `${id}-list`,
          tabIndex: -1,
          "aria-labelledby": `${id}-label`,
          "aria-activedescendant": open && highlight >= 0 ? optionId(highlight) : void 0,
          style: { outline: "none" }
        },
        options.map((option, index) => {
          const isSelected = index === selectedIndex;
          const describedBy = option.description ? `${optionId(index)}-description` : void 0;
          return /* @__PURE__ */ h(
            "div",
            {
              key: option.value || "\0default",
              id: optionId(index),
              role: "option",
              "aria-selected": isSelected,
              "aria-disabled": option.disabled || void 0,
              "aria-label": option.label,
              "aria-describedby": describedBy,
              className: "buzz-select-option",
              "data-highlighted": open && index === highlight ? "" : void 0,
              "data-selected": isSelected ? "" : void 0,
              "data-disabled": option.disabled ? "" : void 0,
              onPointerMove: () => enabled(index) && index !== highlight && setHighlight(index),
              onClick: () => choose(index)
            },
            /* @__PURE__ */ h("span", { className: "buzz-select-option-main" }, option.leading && /* @__PURE__ */ h("span", { className: "buzz-select-leading", "aria-hidden": "true" }, option.leading), /* @__PURE__ */ h("span", { className: "buzz-select-option-content" }, /* @__PURE__ */ h("span", null, option.label), option.description && /* @__PURE__ */ h("span", { id: describedBy, className: "buzz-select-option-description text-body-sm text-subtle" }, option.description))),
            /* @__PURE__ */ h("span", { className: "buzz-select-indicator", "data-selected": isSelected ? "" : void 0, "aria-hidden": "true" }, /* @__PURE__ */ h(CheckIcon, { size: 14 }))
          );
        })
      )
    )
  ));
  return preference ? /* @__PURE__ */ h(PreferenceRow, { title: label, subtitle: description, trailing: control }) : control;
}

// src/ui/models.jsx
var subscribe = (listener) => services.runtime.subscribe(listener);
var catalogNow = () => services.runtime.catalog.snapshot();
var defaultsNow = () => services.runtime.defaults.snapshot();
function useCatalog() {
  const state = useSyncExternalStore(subscribe, catalogNow);
  useEffect(() => {
    void services.runtime.catalog.ensure();
  }, []);
  return { ...state, retry: () => void services.runtime.catalog.check() };
}
var useDefaults = () => useSyncExternalStore(subscribe, defaultsNow);
var logo = () => /* @__PURE__ */ h(GeminiLogoIcon, { size: 20 });
function modelChoices(catalog, defaults, value, { geminiDefaultOnly = false } = {}) {
  const fallback = catalog.models.find((model) => model.id === catalog.default);
  const geminiDefault = fallback?.label || "Gemini default";
  const preferred = !geminiDefaultOnly && defaults.model && catalog.models.find((model) => model.id === defaults.model);
  const defaultName = preferred?.label || (defaults.model && !geminiDefaultOnly ? defaults.model : geminiDefault);
  const listed = catalog.models.filter(
    (model) => geminiDefaultOnly || model.id !== (defaults.model || catalog.default) || model.id === value
  );
  const options = [
    {
      value: "",
      label: geminiDefaultOnly ? geminiDefault : `${defaultName} \xB7 Default`,
      description: geminiDefaultOnly ? "Use Gemini default" : "Following the provider's model default",
      leading: logo()
    },
    ...listed.map((model) => ({ value: model.id, label: model.label, description: model.description, leading: logo() }))
  ];
  if (value && !catalog.loading && !listed.some((model) => model.id === value) && !(preferred && value === defaults.model))
    options.push({ value, label: value, description: "Unavailable model", leading: logo() });
  const chosen = options.find((option) => option.value === value) ?? options[0];
  return {
    options,
    valueLabel: catalog.loading && !catalog.models.length ? "Loading models\u2026" : value ? chosen.label : geminiDefaultOnly ? geminiDefault : defaultName,
    valueSuffix: !value && !geminiDefaultOnly && !catalog.loading ? " \xB7 Default" : void 0,
    valueTitle: chosen.label
  };
}
var effortsOf = (catalog, defaults, model) => catalog.models.find((entry) => entry.id === (model || defaults.model || catalog.default))?.efforts ?? [];
function thinkingChoices(catalog, defaults, current) {
  const efforts = effortsOf(catalog, defaults, current.model);
  return [
    { value: "", label: "Automatic \xB7 Default" },
    ...current.effort && !efforts.some((level) => level.id === current.effort) ? [{ value: current.effort, label: catalog.models.length ? `${effortLabel(current.effort)} (unavailable)` : effortLabel(current.effort) }] : [],
    ...efforts.map((level) => ({ value: level.id, label: effortLabel(level.id) }))
  ];
}
var withModel = (catalog, defaults, current, model) => ({
  ...current,
  model,
  effort: !catalog.models.length || effortsOf(catalog, defaults, model).some((level) => level.id === current.effort) ? current.effort : ""
});
function ModelSelect({ catalog, current, onChange, disabled, variant, appearance = "outlined", align }) {
  const defaults = useDefaults();
  const choice = modelChoices(catalog, defaults, current.model);
  return /* @__PURE__ */ h(
    Select,
    {
      label: "Model",
      value: current.model,
      options: choice.options,
      valueLabel: choice.valueLabel,
      valueSuffix: choice.valueSuffix,
      valueTitle: choice.valueTitle,
      leading: logo(),
      variant,
      appearance,
      size: appearance === "glass-ghost" ? "xs" : void 0,
      align,
      disabled: disabled || catalog.loading && !catalog.models.length,
      onValueChange: (model) => onChange(withModel(catalog, defaults, current, model))
    }
  );
}
function ThinkingSelect({ catalog, current, onChange, disabled, variant }) {
  const defaults = useDefaults();
  return /* @__PURE__ */ h(
    Select,
    {
      label: "Thinking",
      value: current.effort,
      options: thinkingChoices(catalog, defaults, current),
      valueLabel: current.effort ? void 0 : "Automatic",
      valueSuffix: current.effort ? void 0 : " \xB7 Default",
      variant,
      disabled: disabled || !catalog.models.length,
      onValueChange: (effort) => onChange({ ...current, effort })
    }
  );
}

// src/ui/create.jsx
function CreateModel({ config, onChange, onReadyChange, disabled, modelAppearance }) {
  const current = readConfig(config);
  const catalog = useCatalog();
  const ready = !catalog.loading && !catalog.error;
  useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
  return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("div", { style: { ...row, justifyContent: "flex-end" } }, /* @__PURE__ */ h(
    ModelSelect,
    {
      catalog,
      current,
      disabled,
      variant: "compact",
      appearance: modelAppearance ?? "outlined",
      align: "end",
      onChange: (next) => onChange({ ...config, ...next })
    }
  ), catalog.error && /* @__PURE__ */ h(Button, { size: "sm", disabled, loading: catalog.loading, onClick: catalog.retry }, "Try again")), catalog.error && /* @__PURE__ */ h("span", { role: "alert", className: "text-body-sm text-danger" }, catalog.error));
}
function CreateThinking({ config, onChange, disabled }) {
  const catalog = useCatalog();
  return /* @__PURE__ */ h(
    ThinkingSelect,
    {
      catalog,
      current: readConfig(config),
      disabled,
      variant: "compact",
      onChange: (next) => onChange({ ...config, ...next })
    }
  );
}
function CreateConfiguration({ harnessControl, onReadyChange, ...props }) {
  return /* @__PURE__ */ h(SettingsGroup, null, harnessControl, /* @__PURE__ */ h(PreferenceRow, { title: "Model", trailing: /* @__PURE__ */ h(CreateModel, { ...props, onReadyChange }) }), /* @__PURE__ */ h(PreferenceRow, { title: "Thinking", trailing: /* @__PURE__ */ h(CreateThinking, { ...props }) }));
}
function Create({ config, onChange, disabled }) {
  const current = readConfig(config);
  return /* @__PURE__ */ h(
    AgentInstructions,
    {
      creation: true,
      value: current.instructions,
      disabled,
      onChange: (instructions) => onChange({ ...config, instructions })
    }
  );
}
function CreateAction({ disabled }) {
  const catalog = useCatalog();
  if (catalog.readiness !== "attention" || !services.openSetup) return null;
  return /* @__PURE__ */ h(
    Button,
    {
      size: "sm",
      variant: "subtle",
      shape: "capsule",
      disabled,
      "aria-label": catalog.attentionLabel,
      onClick: services.openSetup
    },
    "Set up"
  );
}

// src/ui/provider.jsx
function DefaultControl({ onConfigure }) {
  const catalog = useCatalog();
  const defaults = useDefaults();
  const [error, setError] = useState("");
  const save = (next) => services.runtime.defaults.save({ ...defaults, ...next }).then(
    () => setError(""),
    (reason) => setError(errorText(reason))
  );
  const models = modelChoices(catalog, defaults, defaults.model, { geminiDefaultOnly: true });
  const efforts = effortsOf(catalog, defaults, defaults.model);
  const busy = catalog.loading && !catalog.models.length;
  return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("div", { style: row }, /* @__PURE__ */ h(
    Select,
    {
      label: `${TITLE} default model`,
      value: defaults.model,
      options: models.options,
      valueLabel: models.valueLabel,
      valueTitle: models.valueTitle,
      leading: /* @__PURE__ */ h(GeminiLogoIcon, { size: 20 }),
      align: "end",
      disabled: busy,
      onValueChange: (model) => save({ model, effort: effortsOf(catalog, defaults, model).some((level) => level.id === defaults.effort) ? defaults.effort : "" })
    }
  ), efforts.length > 0 && /* @__PURE__ */ h(
    Select,
    {
      label: "Default thinking",
      value: defaults.effort,
      options: [{ value: "", label: "Automatic" }, ...efforts.map((level) => ({ value: level.id, label: effortLabel(level.id) }))],
      valueLabel: defaults.effort ? effortLabel(defaults.effort) : "Automatic",
      align: "end",
      disabled: busy,
      onValueChange: (effort) => save({ effort })
    }
  ), onConfigure && /* @__PURE__ */ h(Button, { size: "sm", variant: "ghost", onClick: onConfigure }, "Edit configuration")), error && /* @__PURE__ */ h("span", { role: "alert" }, error));
}
function ProviderDialogBody({ onClose }) {
  const catalog = useCatalog();
  const ready = catalog.readiness === "ready";
  const checking = catalog.readiness === "checking";
  const signingIn = Boolean(catalog.signingIn);
  const line = signingIn ? "Finish signing in with Google in your browser\u2026" : checking ? "Checking Gemini\u2026" : ready ? `Signed in with your Google account${catalog.account ? ` (${catalog.account})` : ""}.` : catalog.attentionDescription;
  return /* @__PURE__ */ h("div", { style: stack("var(--space-6)") }, /* @__PURE__ */ h("div", { style: stack("var(--space-2)") }, /* @__PURE__ */ h("p", { role: catalog.readiness === "attention" && !signingIn ? "alert" : "status", className: "text-body-sm text-primary", style: { margin: 0 } }, /* @__PURE__ */ h("strong", null, line)), signingIn && catalog.signInUrl && /* @__PURE__ */ h("p", { className: "text-body-sm text-subtle", style: { margin: 0, overflowWrap: "anywhere" } }, "If no browser opened, open", " ", /* @__PURE__ */ h("a", { href: catalog.signInUrl, target: "_blank", rel: "noreferrer" }, "Google's sign-in page"), "."), catalog.signInError && !signingIn && /* @__PURE__ */ h("p", { role: "alert", className: "text-body-sm text-danger", style: { margin: 0 } }, "Couldn't sign in: ", catalog.signInError), /* @__PURE__ */ h("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, TITLE, " runs Gemini CLI with the Google sign-in on this computer, so a Google AI Pro or Ultra subscription is used, not an API key. Change accounts with /auth in gemini in a terminal.")), ready && /* @__PURE__ */ h(SettingsGroup, null, /* @__PURE__ */ h(PreferenceRow, { title: "Default model", trailing: /* @__PURE__ */ h(DefaultControl, null) })), /* @__PURE__ */ h("div", { style: { ...row, justifyContent: "flex-end" } }, /* @__PURE__ */ h(Button, { onClick: onClose }, ready ? "Done" : "Cancel"), !ready && catalog.canSignIn && /* @__PURE__ */ h(Button, { variant: "prominent", loading: signingIn, disabled: checking, onClick: () => void services.runtime.catalog.signIn() }, "Sign in with Google"), !ready && /* @__PURE__ */ h(Button, { variant: catalog.canSignIn ? "subtle" : "prominent", loading: checking, disabled: signingIn, onClick: catalog.retry }, "Check again")));
}
var providerOf = () => ({
  // Stable until the catalog changes: it is replaced, never changed.
  snapshot: () => services.runtime.catalog.snapshot(),
  // Buzz subscribes when it shows the row: the first read starts there,
  // never inside a snapshot.
  subscribe: (listener) => {
    const unsubscribe = services.runtime.subscribe(listener);
    void services.runtime.catalog.ensure();
    return unsubscribe;
  },
  check: () => services.runtime.catalog.check(),
  DialogBody: ProviderDialogBody,
  DefaultControl
});

// src/ui/settings.jsx
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var LABELS = {
  model: "Model",
  effort: "Thinking",
  instructions: "Instructions",
  workspace: "Workspace",
  scope: "Sessions",
  mode: "Permissions"
};
var shown = (key, value) => key === "scope" ? SCOPES.find(([id]) => id === value)?.[1] : key === "mode" ? MODES.find(([id]) => id === value)?.[1] : value || (key === "instructions" ? "No instructions" : "Default");
function useDraft(saved) {
  const [state, setState] = useState({ draft: saved, latest: saved, conflicts: [] });
  const opened = useRef(saved);
  useEffect(() => {
    const prior = opened.current;
    if (same(prior, saved)) return;
    opened.current = saved;
    setState(({ draft, conflicts }) => {
      const found = new Set(conflicts);
      const next = {};
      for (const key of Object.keys(saved)) {
        if (same(draft[key], prior[key])) next[key] = saved[key];
        else {
          next[key] = draft[key];
          if (!same(saved[key], prior[key]) && !same(draft[key], saved[key])) found.add(key);
        }
      }
      return { draft: next, latest: saved, conflicts: [...found] };
    });
  }, [JSON.stringify(saved)]);
  return {
    ...state,
    setDraft: (draft) => setState((current) => ({ ...current, draft })),
    resolve: (key, useLatest) => setState((current) => ({
      ...current,
      draft: useLatest ? { ...current.draft, [key]: current.latest[key] } : current.draft,
      conflicts: current.conflicts.filter((item) => item !== key)
    }))
  };
}
function Conflict({ field, latest, draft, resolve, disabled }) {
  return /* @__PURE__ */ h("fieldset", { "aria-label": `${LABELS[field]} conflict`, style: { ...stack("var(--space-2)"), margin: 0, padding: "var(--space-3) 0", border: 0 } }, /* @__PURE__ */ h("p", { role: "alert", className: "text-body-sm text-warning", style: { margin: 0 } }, LABELS[field], " changed elsewhere. Choose which changes to keep."), /* @__PURE__ */ h("div", { className: "text-body-sm", style: { overflowWrap: "anywhere" } }, /* @__PURE__ */ h("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, "Latest: ", shown(field, latest[field])), /* @__PURE__ */ h("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, "Yours: ", shown(field, draft[field]))), /* @__PURE__ */ h("div", { style: row }, /* @__PURE__ */ h(Button, { disabled, onClick: () => resolve(field, true) }, "Use latest"), /* @__PURE__ */ h(Button, { disabled, onClick: () => resolve(field, false) }, "Keep mine")));
}
function SettingsTab({ agent, save, settingsHost, settingsSection, settingsContent }) {
  const form = useId();
  const saved = readConfig(agent.config);
  const { draft, latest, conflicts, setDraft, resolve } = useDraft(saved);
  const unavailable = Boolean(agent.configProblem) && !settingsHost?.pendingSave;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const catalog = useCatalog();
  const configChanged = !same(draft, saved);
  const changed = configChanged || Boolean(settingsHost?.pendingSave);
  const submit = async () => {
    if (saving || !changed || conflicts.length || unavailable) return;
    const next = readConfig(draft);
    setDraft(next);
    setSaving(true);
    setError("");
    try {
      await save({ ...agent.config, ...next }, { base: agent.configBase ?? {} });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ h(
    "form",
    {
      id: form,
      style: { ...stack(), containerType: "inline-size" },
      onSubmit: (event) => {
        event.preventDefault();
        void submit();
      }
    },
    error && /* @__PURE__ */ h("p", { ref: errorRef, tabIndex: -1, role: "alert", className: "buzz-field-error" }, error),
    unavailable && /* @__PURE__ */ h("p", { className: "text-body-sm text-muted", style: { margin: 0 } }, "Your edits stay in this form. You can save them when configuration is available again."),
    settingsSection !== "runtime" && /* @__PURE__ */ h(Fragment, null, ["model", "effort"].filter((field) => conflicts.includes(field)).map((field) => /* @__PURE__ */ h(Conflict, { key: field, field, latest, draft, resolve, disabled: saving })), /* @__PURE__ */ h(SettingsGroup, null, settingsHost?.typeControl?.(configChanged) ?? null, /* @__PURE__ */ h(ModelSelect, { catalog, current: draft, onChange: setDraft, variant: "preference", align: "start" }), /* @__PURE__ */ h(ThinkingSelect, { catalog, current: draft, onChange: setDraft, variant: "preference" })), catalog.error && /* @__PURE__ */ h("div", { style: row }, /* @__PURE__ */ h("span", { role: "alert", className: "text-body-sm text-danger" }, catalog.error), /* @__PURE__ */ h(Button, { size: "sm", loading: catalog.loading, onClick: catalog.retry }, "Try again")), /* @__PURE__ */ h("div", { style: stack("var(--space-2)") }, conflicts.includes("instructions") && /* @__PURE__ */ h(Conflict, { field: "instructions", latest, draft, resolve, disabled: saving }), /* @__PURE__ */ h(
      AgentInstructions,
      {
        value: draft.instructions,
        disabled: false,
        onChange: (instructions) => setDraft({ ...draft, instructions })
      }
    ))),
    settingsSection !== "identity" && /* @__PURE__ */ h(Fragment, null, ["workspace", "scope", "mode"].filter((field) => conflicts.includes(field)).map((field) => /* @__PURE__ */ h(Conflict, { key: field, field, latest, draft, resolve, disabled: saving })), /* @__PURE__ */ h("div", { style: stack("var(--space-2)") }, /* @__PURE__ */ h(Field, { label: "Workspace", description: "The folder Gemini works in. Use ~/ for your home folder." }, (control) => /* @__PURE__ */ h(
      Input,
      {
        ...control,
        value: draft.workspace,
        spellCheck: false,
        autoCorrect: "off",
        autoCapitalize: "none",
        onValueChange: (workspace) => setDraft({ ...draft, workspace })
      }
    ))), /* @__PURE__ */ h(
      Select,
      {
        label: "Sessions",
        variant: "preference",
        value: draft.scope,
        options: SCOPES.map(([value, label]) => ({ value, label })),
        onValueChange: (scope) => setDraft({ ...draft, scope: scope === "channel" ? "channel" : "thread" })
      }
    ), /* @__PURE__ */ h(
      Select,
      {
        label: "Permissions",
        variant: "preference",
        value: draft.mode,
        options: MODES.map(([value, label, description]) => ({ value, label, description })),
        onValueChange: (mode) => setDraft({ ...draft, mode })
      }
    )),
    /* @__PURE__ */ h(SaveButton, { form, saving, visible: changed, disabled: conflicts.length > 0 || unavailable }),
    settingsSection !== "identity" ? settingsContent ?? null : null
  );
}

// src/index.js
var inject = ["react", "agents", "host"];
function apply(ctx) {
  const { agents, host } = ctx;
  if (!host.spawn || !host.serveMcp || !host.resolveDirectory) return;
  if (!agents.harness || !agents.storage)
    throw new Error(`${TITLE} needs a newer Buzz: this one does not let plugins run agent harnesses.`);
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const runtime = new Runtime({ agents, host, typeKey });
  const navigation = ctx.reflect?.get?.("navigation");
  bindReact(ctx.react);
  bindServices({
    runtime,
    agents,
    openSetup: navigation && (() => void navigation.open({ version: 1, kind: "settings", section: "agents", provider: typeKey }))
  });
  ctx.effect(() => {
    runtime.sync();
    const unsubscribe = agents.subscribe(() => runtime.sync());
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  });
  agents.register({
    id: TYPE_ID,
    title: TITLE,
    icon: HarnessIcon,
    description: "Gemini on this computer, signed in with your own Google account. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: { ...DEFAULTS } }),
    summary: (agent) => readConfig(agent.config).model || TITLE,
    // New agent
    Create,
    CreateAction,
    CreateConfiguration,
    CreateModel,
    createModelReportsReadiness: true,
    CreateThinking,
    // Changing harness, sharing, syncing
    adopt,
    carry,
    describeMigration,
    exportShared: (saved) => ({ runtime: "gemini", model: readConfig(saved).model }),
    importShared: (source) => source.runtime === "gemini" ? { ...DEFAULTS, model: source.model ?? "" } : void 0,
    syncedSettings: { schema: SYNCED_SCHEMA, withSynced: withSyncedSettings },
    // Settings and views
    tabs: [
      { id: "settings", title: "Settings", role: "settings", splitSettings: true, reconcilesConfig: true, component: SettingsTab },
      { id: "activity", title: "Activity", role: "activity", component: ActivityTab }
    ],
    provider: providerOf(),
    sessions: { list: (key) => runtime.sessionList(key), subscribe: runtime.subscribe },
    // Gemini reports each turn's tokens; they are kept as they come.
    usage: (agent, options) => runtime.usage.read(agent.key, options),
    models: (agent) => runtime.models(agent),
    // Running
    resumes: true,
    sessionControls: {
      scope: runtime.scope,
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action, reset) => runtime.control(agent, place, action, reset),
      subscribe: runtime.subscribe
    },
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    readFile: (agent, path) => host.readFile(path, { cwd: readConfig(agent.config).workspace })
  });
}
export {
  apply,
  inject
};
