import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LIVE_SESSIONS } from "../src/constants.js";
import { COMPACT_PROMPT } from "../src/runtime/conversation.js";
import { Runtime } from "../src/runtime/runtime.js";
import { fakeAgents, fakeKit, fakeStorage, mention } from "./fake-buzz.js";
import { fakeGemini, fakeHostFor, tick } from "./fake-gemini.js";

const TYPE = "local.gemini-acp/gemini-acp";
let runtimes = [];

function setup({ script = {}, storage = fakeStorage(), kit = fakeKit() } = {}) {
  const gemini = fakeGemini(script);
  const host = fakeHostFor(gemini);
  const agents = fakeAgents({ kit, storage });
  const runtime = new Runtime({ agents, host, typeKey: TYPE });
  runtimes.push(runtime);
  return { runtime, gemini, host, agents, kit, storage, script };
}

const settle = async (message) => {
  await tick(20);
  return message.done();
};
const calls = (gemini, method) => gemini.state.calls.filter((call) => call.method === method);

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes = [];
  vi.useRealTimers();
});

describe("a mention", () => {
  it("runs one turn in a new session, shown Buzz's prompt once, with the Buzz tools", async () => {
    const { runtime, gemini, host, kit } = setup();
    const message = mention("hello", { root: "t", config: { instructions: "Review PRs" } });
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: true });
    expect(message.seen.acknowledged).toBe(1);
    expect(message.seen.steps).toContain("send");
    const session = gemini.state.sessions.get("s1");
    expect(session.mcp).toBe(host.servers[0].url);
    expect(session.prompts[0]).toMatch(/^system: Review PRs\n\ncontext\n<buzz-event>\nhello/);
    // Bypass permissions runs as Gemini's YOLO.
    expect(session.mode).toBe("yolo");
    expect(kit.tools).toHaveBeenCalled();

    const second = mention("again", { root: "t", config: { instructions: "Review PRs" } });
    await runtime.run(second.delivery);
    await settle(second);
    expect(session.prompts[1]).toMatch(/^context\n<buzz-event>\nagain/);
  });

  it("continues the thread's session and saves it", async () => {
    const { runtime, gemini, storage } = setup();
    for (const text of ["one", "two"]) {
      const message = mention(text, { root: "t1" });
      await runtime.run(message.delivery);
      await settle(message);
    }
    expect(gemini.state.sessions.size).toBe(1);
    await runtime.records.flush();
    const own = JSON.parse(storage.data.get(`${TYPE}/agent-1`));
    expect(own.conversations["c1/t1"]).toMatchObject({ sessionId: "s1", cursor: JSON.stringify({ seen: 2 }), primed: true, where: "#general" });
  });

  it("applies the device default model, a per-message pick, and back to the default", async () => {
    const { runtime, gemini } = setup();
    await runtime.defaults.save({ model: "gemini-2.5-flash", effort: "" });
    const run = async (text, options) => {
      const message = mention(text, { root: "t", ...options });
      await runtime.run(message.delivery);
      await settle(message);
    };
    const session = () => gemini.state.sessions.get("s1");
    await run("one");
    expect(session().model).toBe("gemini-2.5-flash");
    await run("two", { model: "gemini-3-pro-preview" });
    expect(session().model).toBe("gemini-3-pro-preview");
    await runtime.defaults.save({ model: "", effort: "" });
    await run("three");
    // The model the session started on, Gemini's own default.
    expect(session().model).toBe("auto");
  });

  it("refuses a synced model Gemini doesn't offer instead of swapping it", async () => {
    const { runtime, kit } = setup();
    const message = mention("x", { config: { model: "gpt-9" }, synced: { model: "gpt-9" } });
    await runtime.run(message.delivery);
    const result = await settle(message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/synced model "gpt-9" isn't offered/);
    expect(kit.replies[0]).toMatchObject({ options: { notifyOwner: true } });
  });

  it("starts a new session when instructions change", async () => {
    const { runtime, gemini } = setup();
    for (const config of [{}, { instructions: "New role" }]) {
      const message = mention("x", { config });
      await runtime.run(message.delivery);
      await settle(message);
    }
    expect(gemini.state.sessions.size).toBe(2);
  });
});

describe("mid-turn messages and Stop", () => {
  it("runs a message that arrives mid-turn as the next turn, never two prompts at once", async () => {
    const { runtime, gemini, script } = setup();
    const { prompt, turns } = gemini.hanging();
    script.prompt = prompt;
    const first = mention("count", { root: "t" });
    await runtime.run(first.delivery);
    await tick(20);
    const second = mention("and banana", { root: "t" });
    await runtime.run(second.delivery);
    await tick(20);
    const session = gemini.state.sessions.get("s1");
    expect(session.prompts).toHaveLength(1);
    turns[0].finish();
    expect(await first.done()).toEqual({ ok: true });
    await tick(20);
    expect(session.prompts[1]).toMatch(/and banana/);
    turns[1].finish();
    expect(await second.done()).toEqual({ ok: true });
  });

  it("stops the running turn", async () => {
    const { runtime, gemini, script } = setup();
    script.prompt = gemini.hanging().prompt;
    const message = mention("long");
    await runtime.run(message.delivery);
    await tick(20);
    await message.delivery.stop();
    expect(await message.done()).toEqual({ ok: true, stopped: true });
    expect(calls(gemini, "session/cancel")).toHaveLength(1);
  });

  it("drops a queued message on Stop without stopping the running one", async () => {
    const { runtime, gemini, script } = setup();
    const { prompt, turns } = gemini.hanging();
    script.prompt = prompt;
    const first = mention("one", { root: "t" });
    await runtime.run(first.delivery);
    await tick(20);
    const queued = mention("two", { root: "t" });
    await runtime.run(queued.delivery);
    await queued.delivery.stop();
    expect(await queued.done()).toEqual({ ok: true, stopped: true });
    expect(calls(gemini, "session/cancel")).toHaveLength(0);
    turns[0].finish();
    await first.done();
    expect(gemini.state.sessions.get("s1").prompts).toHaveLength(1);
  });
});

describe("failures", () => {
  it("reports a failed turn to the owner and keeps the session", async () => {
    const script = {
      prompt: () => {
        throw Object.assign(new Error("Rate limit exceeded. Try again later."), { code: 429 });
      },
    };
    const { runtime, kit, gemini } = setup({ script });
    const message = mention("x");
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: false, error: "Rate limit exceeded. Try again later." });
    expect(kit.replies[0].text).toBe("Gemini (ACP) could not finish: Rate limit exceeded. Try again later.");
    expect(gemini.state.sessions.size).toBe(1);
  });

  it("explains a full context window", async () => {
    const { runtime } = setup({ script: { prompt: () => ({ stopReason: "max_tokens" }) } });
    const message = mention("x");
    await runtime.run(message.delivery);
    expect((await settle(message)).error).toMatch(/context window is full\. Compact the session/);
  });

  it("recovers a turn whose process died before Gemini began, by loading the session", async () => {
    let crash = true;
    const script = {
      prompt: (params, { state }) => {
        if (crash && state.sessions.get(params.sessionId).prompts.length === 2) {
          crash = false;
          state.processes.at(-1).crash(1);
          return new Promise(() => {});
        }
        return { stopReason: "end_turn" };
      },
    };
    const { runtime, gemini } = setup({ script });
    const first = mention("one", { root: "t" });
    await runtime.run(first.delivery);
    await settle(first);
    const second = mention("two", { root: "t" });
    await runtime.run(second.delivery);
    expect(await settle(second)).toEqual({ ok: true });
    expect(gemini.state.processes).toHaveLength(2);
    expect(calls(gemini, "session/load")).toHaveLength(1);
  });

  it("starts a new session when the saved one is gone", async () => {
    const storage = fakeStorage();
    storage.data.set(`${TYPE}/agent-1`, JSON.stringify({ v: 1, conversations: { c1: { sessionId: "gone", at: 1, primed: true } } }));
    const { runtime, gemini } = setup({ storage });
    const message = mention("x");
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: true });
    // A new session is shown Buzz's prompt again.
    expect(gemini.state.sessions.get("s1").prompts[0]).toMatch(/^system/);
  });

  it("keeps the saved session when loading fails for another reason than its loss", async () => {
    const storage = fakeStorage();
    storage.data.set(`${TYPE}/agent-1`, JSON.stringify({ v: 1, conversations: { c1: { sessionId: "kept", at: 1 } } }));
    const script = { "session/load": () => Promise.reject(Object.assign(new Error("timed out"), { code: -32603 })) };
    const { runtime } = setup({ script, storage });
    const message = mention("x", { config: { scope: "channel" } });
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: false, error: "timed out" });
    await runtime.records.flush();
    expect(JSON.parse(storage.data.get(`${TYPE}/agent-1`)).conversations.c1.sessionId).toBe("kept");
  });

  it("stops quietly, without a failure reply, when the agent is removed mid-turn", async () => {
    const { runtime, gemini, script, agents, kit } = setup();
    script.prompt = gemini.hanging().prompt;
    const message = mention("long");
    await runtime.run(message.delivery);
    await tick(20);
    agents.running.length = 0;
    runtime.sync();
    expect(await message.done()).toEqual({ ok: true, stopped: true });
    await tick();
    expect(kit.replies).toHaveLength(0);
    expect(gemini.state.processes[0].killed).toBe(true);
  });
});

describe("session controls", () => {
  it("New session forgets the session; the next message starts and primes another", async () => {
    const { runtime, gemini, storage } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const agent = { key: "agent-1", config: message.delivery.config };
    await runtime.control(agent, { channelId: "c1", root: "t" }, "new");
    await runtime.records.flush();
    expect(JSON.parse(storage.data.get(`${TYPE}/agent-1`)).conversations["c1/t"]).toBeUndefined();
    const again = mention("y", { root: "t" });
    await runtime.run(again.delivery);
    await settle(again);
    expect(gemini.state.sessions.get("s2").prompts[0]).toMatch(/^system/);
  });

  it("compacts into a new session that starts from Gemini's summary", async () => {
    const script = {
      prompt: (params, { update }) => {
        if (params.prompt[0].text === COMPACT_PROMPT) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "We counted to 3." } });
          return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "end_turn" }), 5));
        }
        return { stopReason: "end_turn" };
      },
    };
    const { runtime, gemini, host, kit } = setup({ script });
    const first = mention("count", { root: "t" });
    await runtime.run(first.delivery);
    await settle(first);
    const agent = { key: "agent-1", config: first.delivery.config };
    const place = { channelId: "c1", root: "t" };
    const compacting = runtime.control(agent, place, "compact");
    await tick(1);
    expect(runtime.sessionState(agent, place)).toBe("compacting");
    // Nothing posts while Gemini summarizes.
    const posted = await host.servers[0].handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send" } });
    expect(posted.error.message).toBe("No Buzz turn is running");
    await compacting;
    expect(host.servers[0].open).toBe(false);
    const next = mention("and now?", { root: "t" });
    await runtime.run(next.delivery);
    await settle(next);
    const fresh = gemini.state.sessions.get("s2").prompts[0];
    expect(fresh).toMatch(/^system\n\n<previous-session-summary>\nWe counted to 3\.\n<\/previous-session-summary>/);
    // Shown only what came after: the cursor carried over.
    expect(kit.turnPrompt.mock.calls.at(-1)[2]).toEqual({ cursor: JSON.stringify({ seen: 1 }) });
  });

  it("reports state and refuses to compact while busy", async () => {
    const { runtime, gemini, script } = setup();
    const { prompt, turns } = gemini.hanging();
    script.prompt = prompt;
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await tick(20);
    const agent = { key: "agent-1", config: message.delivery.config };
    const place = { channelId: "c1", root: "t" };
    expect(runtime.sessionState(agent, place)).toBe("active");
    await expect(runtime.control(agent, place, "compact")).rejects.toThrow(/Wait for the active turn/);
    turns[0].finish();
    await message.done();
    await tick();
    expect(runtime.sessionState(agent, place)).toBe("idle");
  });
});

describe("resources", () => {
  it("closes an idle session's MCP server and its process, then loads the session again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runtime, host, gemini } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await vi.advanceTimersByTimeAsync(50);
    await message.done();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10);
    expect(host.servers[0].open).toBe(false);
    expect(gemini.state.processes[0].killed).toBe(true);
    const again = mention("y", { root: "t" });
    await runtime.run(again.delivery);
    await vi.advanceTimersByTimeAsync(50);
    expect(await again.done()).toEqual({ ok: true });
    expect(calls(gemini, "session/load")).toHaveLength(1);
    // Replayed history is not taken for this turn's work.
    expect(again.seen.steps).toEqual(["send"]);
    expect(gemini.state.sessions.get("s1").prompts[1]).toMatch(/^context/);
  });

  it(`keeps at most ${MAX_LIVE_SESSIONS} sessions open, closing the least recently used`, async () => {
    const { runtime, host } = setup();
    for (let index = 0; index <= MAX_LIVE_SESSIONS; index += 1) {
      const message = mention(`m${index}`, { root: `t${index}` });
      await runtime.run(message.delivery);
      await settle(message);
    }
    expect(runtime.live.size).toBe(MAX_LIVE_SESSIONS);
    expect(host.servers[0].open).toBe(false);
    expect(host.servers.filter((server) => server.open)).toHaveLength(MAX_LIVE_SESSIONS);
  });
});

describe("standalone turns", () => {
  it("runs a timer in a one-off session, shown Buzz's prompt, and records its usage", async () => {
    const { runtime, gemini, host } = setup();
    const { delivery } = mention("unused");
    const result = await runtime.runOnce({ delivery, key: "timer/1", signal: new AbortController().signal, prompt: async () => "tick" });
    expect(result).toEqual({ ok: true });
    expect(gemini.state.sessions.get("s1").prompts[0]).toBe("system\n\n<timer>tick</timer>");
    expect(host.servers[0].open).toBe(false);
    const [usage] = await runtime.usage.read("agent-1", { since: 0 });
    expect(usage).toMatchObject({ id: "s1", wake: "timer/1", gaps: [] });
  });

  it("doesn't run once its deadline passed while the prompt was read", async () => {
    const { runtime, gemini } = setup();
    const { delivery } = mention("unused");
    const abort = new AbortController();
    const result = await runtime.runOnce({
      delivery,
      key: "timer/1",
      signal: abort.signal,
      prompt: async () => {
        abort.abort();
        return "late";
      },
    });
    expect(result.ok).toBe(false);
    expect(gemini.state.sessions.get("s1").prompts).toBeUndefined();
  });
});

describe("activity and usage", () => {
  it("records each turn's transcript, with posted messages, tools and the outcome", async () => {
    const script = {};
    const { runtime, host } = setup({ script });
    script.prompt = async (params, { update }) => {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "**Plan**\nlook first" } });
      update({ sessionUpdate: "tool_call", toolCallId: "read_file_1732000000000_0", status: "in_progress", title: "README.md", kind: "read" });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "read_file_1732000000000_0",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# Hi" } }],
      });
      update({ sessionUpdate: "tool_call", toolCallId: "mcp_buzz_send_1732000000000_1", status: "in_progress", title: "send()" });
      await tick(5);
      // Gemini calls Buzz's send tool on the session's own MCP server.
      const call = { name: "send", arguments: { text: "Done!" } };
      await host.servers.at(-1).handler({ jsonrpc: "2.0", id: 9, method: "tools/call", params: call });
      return { stopReason: "end_turn" };
    };
    const message = mention("read it", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const { turns } = await runtime.transcript("agent-1", "c1/t");
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({ channelId: "c1", threadRootId: "t", newSession: true, outcome: "ended" });
    expect(turn.config).toEqual(["Auto (Gemini 3)", "Bypass permissions"]);
    expect(turn.items.map((item) => item.type)).toEqual(["system", "prompt", "thought", "tool", "message"]);
    expect(turn.items[1].text).toBe("read it");
    expect(turn.items[3]).toMatchObject({ title: "README.md", kind: "read", status: "completed", output: "# Hi" });
    expect(turn.items[4]).toMatchObject({ text: "Done!", posted: true });
  });

  it("lists conversations for the Activity tab by their names", async () => {
    const { runtime } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const rows = runtime.conversationRows("agent-1");
    expect(rows).toBe(runtime.conversationRows("agent-1"));
    expect(rows[0]).toMatchObject({ key: "c1/t", channelId: "c1", root: "t", where: "#general", status: "Idle" });
    expect(runtime.sessionList("agent-1")[0]).toMatchObject({ channelId: "c1", root: "t", status: "Idle" });
  });

  it("reports usage by session, where it started", async () => {
    const { runtime } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const [session] = await runtime.usage.read("agent-1", { since: 0 });
    expect(session).toMatchObject({
      id: "s1",
      channelId: "c1",
      root: "t",
      observations: [{ model: "gemini-3-pro-preview", tokens: { input: 200, output: 50, cacheRead: 1000 } }],
    });
    expect(await runtime.usage.read("agent-1", { since: Date.now() + 1000 })).toEqual([]);
  });
});

describe("readiness", () => {
  it("lists Gemini's models with no thinking levels, and the signed-in account", async () => {
    const { runtime } = setup();
    await runtime.defaults.save({ model: "gemini-2.5-flash", effort: "" });
    const models = await runtime.models({ config: {} });
    expect(models.current).toBe("gemini-2.5-flash");
    expect(models.models.map((model) => model.id)).toEqual(["auto", "gemini-3-pro-preview", "gemini-2.5-flash"]);
    expect(models.models[0].efforts).toEqual([]);
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "ready", account: "me@example.com", default: "auto" });
  });

  it("asks to sign in, and signs in with Google through Gemini CLI", async () => {
    const { runtime, gemini } = setup();
    gemini.state.signedIn = false;
    await runtime.catalog.check();
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "attention", attentionLabel: "Sign in to Gemini", canSignIn: true });
    await expect(runtime.models({ config: {} })).rejects.toThrow(/Sign in to Gemini/);
    await runtime.catalog.signIn();
    expect(calls(gemini, "authenticate")[0].params).toEqual({ methodId: "oauth-personal" });
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "ready", signingIn: false });
  });
});
