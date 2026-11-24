// A scripted stand-in for Gemini CLI in its ACP mode, speaking the protocol
// as Gemini CLI 0.70 does (`session/load`, `session/set_mode`,
// `session/set_model`, no steering, no `session/close`), with hooks to make
// turns hang, fail or crash.

const MODELS = [
  { modelId: "auto", name: "Auto (Gemini 3)", description: "Lets Gemini choose" },
  { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
  { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];
const MODES = ["default", "autoEdit", "yolo", "plan"].map((id) => ({ id, name: id }));

/** `script.prompt(params, session)` decides each turn; by default a turn
 * posts with Buzz's send tool and ends. Returns Gemini and what it was sent. */
export function fakeGemini(script = {}) {
  const state = { sessions: new Map(), next: 0, processes: [], calls: [], signedIn: true };
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
        const reply = (result) => emit({ jsonrpc: "2.0", id: message.id, result });
        const fail = (code, text) => emit({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
        try {
          const result = await handle(message.method, message.params ?? {}, { emit, process });
          if (result !== undefined) reply(result);
        } catch (error) {
          fail(error.code ?? -32000, error.message);
        }
      },
    };
    const emit = (message) => setTimeout(() => spawnOptions.onStdout?.(`${JSON.stringify(message)}\n`), 0);
    state.processes.push(process);
    return process;
  };

  const update = (emit, sessionId, update) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  const answer = (session) => ({
    modes: { availableModes: MODES, currentModeId: session.mode },
    models: { availableModels: MODELS, currentModelId: session.model },
  });

  async function handle(method, params, { emit }) {
    if (script[method]) {
      const result = await script[method](params, { emit, state });
      if (result !== undefined) return result;
    }
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
        };
      case "authenticate":
        state.signedIn = true;
        return {};
      case "session/new": {
        if (!state.signedIn) throw Object.assign(new Error("Authentication required."), { code: -32000 });
        const sessionId = `s${++state.next}`;
        const session = { id: sessionId, mode: "default", model: "auto", mcp: params.mcpServers?.[0]?.url };
        state.sessions.set(sessionId, session);
        // As Gemini CLI does, right after it answers.
        setTimeout(() => update(emit, sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] }), 1);
        return { sessionId, ...answer(session) };
      }
      case "session/load": {
        const session = state.sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error("Invalid session identifier format."), { code: -32602 });
        session.mcp = params.mcpServers?.[0]?.url;
        session.loads = (session.loads ?? 0) + 1;
        // History is replayed before the answer.
        for (const text of session.prompts ?? []) update(emit, params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
        return answer(session);
      }
      case "session/set_mode": {
        state.sessions.get(params.sessionId).mode = params.modeId;
        return {};
      }
      case "session/set_model": {
        state.sessions.get(params.sessionId).model = params.modelId;
        return {};
      }
      case "session/prompt": {
        const session = state.sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error(`Session not found: ${params.sessionId}`), { code: -32602 });
        session.prompts = [...(session.prompts ?? []), params.prompt[0].text];
        if (script.prompt) return script.prompt(params, { session, emit, update: (u) => update(emit, params.sessionId, u), state });
        update(emit, params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `mcp_buzz_send_${Date.now()}_0`,
          status: "in_progress",
          title: "send(final: true)",
          kind: "other",
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 1200, outputTokens: 40, cachedReadTokens: 1000, thoughtTokens: 10, totalTokens: 1240 },
          _meta: { quota: { model_usage: [{ model: session.model === "auto" ? "gemini-3-pro-preview" : session.model, token_count: { input_tokens: 1200, output_tokens: 40 } }] } },
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
        update({
          sessionUpdate: "tool_call",
          toolCallId: `run_shell_command_${Date.now()}_1`,
          status: "in_progress",
          title: "sleep 60",
          kind: "execute",
        });
        const end = (stopReason) => {
          session.running = false;
          resolve({ stopReason });
        };
        session.cancel = () => end("cancelled");
        turns.push({ session, finish: (text) => (text && update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }), setTimeout(() => end("end_turn"), 2)) });
      });
    return { prompt, turns };
  };

  return { spawn, state, hanging };
}

export function fakeHostFor(gemini) {
  const servers = [];
  return {
    servers,
    spawn: gemini.spawn,
    resolveDirectory: async (path) => path.replace(/^~/, "/home/test"),
    readFile: async (path, { cwd } = {}) => {
      if (cwd === "/home/test/.gemini" && path === "google_accounts.json")
        return new TextEncoder().encode(JSON.stringify({ active: "me@example.com", old: [] }));
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
