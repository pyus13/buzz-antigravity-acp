// A scripted stand-in for Antigravity CLI's ACP server (`agy acp`), speaking
// the protocol as agy 1.5 does: config options for model, thinking and mode,
// resume and close, `_meta.antigravity` for the system prompt and plan, a
// prompt sent mid-turn steering it, and `/compact`. Hooks make turns hang,
// fail or crash.

const options = (model = "gemini-3.8-flash", effort = "high", mode = "default") => [
  {
    id: "model",
    category: "model",
    currentValue: model,
    options: [
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    ],
  },
  ...(model.startsWith("gemini")
    ? [{ id: "thought_level", category: "thought_level", currentValue: effort, options: ["low", "medium", "high"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) }]
    : []),
  { id: "mode", category: "mode", currentValue: mode, options: ["default", "accept-edits", "auto", "plan"].map((value) => ({ value, name: value })) },
];
const PRO = { id: "g1-pro-tier", name: "Google AI Pro" };

export function fakeAgy(script = {}) {
  const state = { sessions: new Map(), next: 0, processes: [], calls: [], signedIn: true, tier: PRO };
  const spawn = async (id, spawnOptions) => {
    let exit;
    const exited = new Promise((resolve) => {
      exit = resolve;
    });
    const process = {
      exited,
      killed: false,
      options: spawnOptions,
      kill: async () => {
        process.killed = true;
        exit(null);
      },
      crash: (code = 1) => exit(code),
      write: async (line) => {
        const message = JSON.parse(line);
        state.calls.push(message);
        if (message.method === "session/cancel") {
          state.sessions.get(message.params.sessionId)?.cancel?.();
          return;
        }
        if (!message.method) return;
        try {
          const result = await handle(message.method, message.params ?? {}, { emit });
          if (result !== undefined) emit({ jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          emit({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32000, message: error.message } });
        }
      },
    };
    const emit = (message) => setTimeout(() => spawnOptions.onStdout?.(`${JSON.stringify(message)}\n`), 0);
    state.processes.push(process);
    return process;
  };

  const update = (emit, sessionId, update) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  const meta = () => ({ _meta: { antigravity: { tier: state.tier } } });

  async function handle(method, params, { emit }) {
    if (script[method]) {
      const result = await script[method](params, { emit, state });
      if (result !== undefined) return result;
    }
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
            mcpCapabilities: { http: true },
            auth: { logout: {} },
            _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
          },
        };
      case "authenticate":
        state.signedIn = true;
        return meta();
      case "logout":
        state.signedIn = false;
        return {};
      case "session/new": {
        if (!state.signedIn) throw Object.assign(new Error("Authentication required"), { code: -32000 });
        const sessionId = `s${++state.next}`;
        state.sessions.set(sessionId, {
          id: sessionId,
          options: options(),
          mcp: params.mcpServers?.[0]?.url,
          system: params._meta?.antigravity?.systemPrompt?.append,
        });
        return { sessionId, configOptions: state.sessions.get(sessionId).options, ...meta() };
      }
      case "session/resume": {
        const session = state.sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error(`session ${params.sessionId} not found`), { code: -32002 });
        session.mcp = params.mcpServers?.[0]?.url;
        session.resumes = (session.resumes ?? 0) + 1;
        return { sessionId: params.sessionId, configOptions: session.options, ...meta() };
      }
      case "session/close":
        return {};
      case "session/set_config_option": {
        const session = state.sessions.get(params.sessionId);
        const get = (id) => session.options.find((item) => item.id === id)?.currentValue;
        const next = { model: get("model"), thought_level: get("thought_level") ?? "high", mode: get("mode"), [params.configId]: params.value };
        session.options = options(next.model, next.thought_level, next.mode);
        return { configOptions: session.options };
      }
      case "session/prompt": {
        const session = state.sessions.get(params.sessionId);
        const text = params.prompt[0].text;
        session.prompts = [...(session.prompts ?? []), text];
        // A prompt sent while a turn runs joins it, and the earlier prompt
        // is answered at once.
        if (session.running) {
          session.steered = [...(session.steered ?? []), text];
          const earlier = session.answer;
          session.answer = undefined;
          earlier?.({ stopReason: "end_turn" });
          return new Promise((resolve) => (session.answer = resolve));
        }
        if (script.prompt) return script.prompt(params, { session, emit, update: (u) => update(emit, params.sessionId, u), state });
        update(emit, params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", name: "mcp_buzz_send", kind: "other", status: "in_progress", title: "Run mcp_buzz_send", rawInput: { text: "hi" } });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 1200, outputTokens: 40, cachedReadTokens: 1000, cachedWriteTokens: 0, thoughtTokens: 10, totalTokens: 2250 },
        };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  /** A turn that runs until cancelled or `finish()`ed. */
  const hanging = () => {
    const turns = [];
    const prompt = (params, { session, update }) =>
      new Promise((resolve) => {
        session.running = true;
        session.answer = resolve;
        update({ sessionUpdate: "tool_call", toolCallId: "call_2", name: "run_command", kind: "execute", status: "in_progress", title: "sleep 60", rawInput: { CommandLine: "sleep 60" } });
        const end = (stopReason) => {
          session.running = false;
          const answer = session.answer;
          session.answer = undefined;
          answer?.({ stopReason });
        };
        session.cancel = () => end("cancelled");
        turns.push({ session, finish: () => end("end_turn") });
      });
    return { prompt, turns };
  };

  return { spawn, state, hanging };
}

export function fakeHostFor(agy) {
  const servers = [];
  return {
    servers,
    spawn: agy.spawn,
    resolveDirectory: async (path) => path.replace(/^~/, "/home/test"),
    readFile: async () => {
      throw new Error("not found");
    },
    serveMcp: async (handler) => {
      let close;
      const server = {
        url: `http://127.0.0.1/mcp/${servers.length + 1}`,
        headers: [{ name: "Authorization", value: "Bearer t" }],
        open: true,
        handler,
        closed: new Promise((resolve) => {
          close = resolve;
        }),
        close: async () => {
          server.open = false;
          close();
        },
        /** As Buzz does when another program used the token. */
        stopByHost: () => {
          server.open = false;
          close();
        },
      };
      servers.push(server);
      return server;
    },
  };
}

export const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
