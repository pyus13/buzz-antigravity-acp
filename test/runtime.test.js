import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LIVE_SESSIONS } from "../src/constants.js";
import { PLAN_NUDGE } from "../src/runtime/conversation.js";
import { Runtime } from "../src/runtime/runtime.js";
import { fakeAgents, fakeKit, fakeStorage, mention } from "./fake-buzz.js";
import { fakeAgy, fakeHostFor, tick } from "./fake-agy.js";

const TYPE = "local.antigravity-acp/antigravity-acp";
let runtimes = [];

function setup({ script = {}, storage = fakeStorage(), kit = fakeKit() } = {}) {
  const agy = fakeAgy(script);
  const host = fakeHostFor(agy);
  const agents = fakeAgents({ kit, storage });
  const runtime = new Runtime({ agents, host, typeKey: TYPE });
  runtimes.push(runtime);
  return { runtime, agy, host, agents, kit, storage, script };
}

const settle = async (message) => {
  await tick(20);
  return message.done();
};
const calls = (agy, method) => agy.state.calls.filter((call) => call.method === method);
const value = (session, id) => session.options.find((option) => option.id === id)?.currentValue;

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes = [];
  vi.useRealTimers();
});

describe("a mention", () => {
  it("runs one turn in a new session with the Buzz tools and Buzz's prompt after Antigravity's", async () => {
    const { runtime, agy, host, kit } = setup();
    const message = mention("hello", { config: { instructions: "Review PRs" } });
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: true });
    expect(message.seen.acknowledged).toBe(1);
    expect(message.seen.steps).toContain("send");
    const session = agy.state.sessions.get("s1");
    expect(session.mcp).toBe(host.servers[0].url);
    expect(session.system).toBe("system: Review PRs");
    expect(session.prompts[0]).toMatch(/^context\n<buzz-event>\nhello/);
    expect(value(session, "mode")).toBe("accept-edits");
    expect(kit.tools).toHaveBeenCalled();
  });

  it("continues the thread's session and saves it", async () => {
    const { runtime, agy, storage } = setup();
    for (const text of ["one", "two"]) {
      const message = mention(text, { root: "t1" });
      await runtime.run(message.delivery);
      await settle(message);
    }
    expect(agy.state.sessions.size).toBe(1);
    await runtime.records.flush();
    const own = JSON.parse(storage.data.get(`${TYPE}/agent-1`));
    expect(own.conversations["c1/t1"]).toMatchObject({ sessionId: "s1", cursor: JSON.stringify({ seen: 2 }), where: "#general" });
  });

  it("applies the device default model and thinking, a per-message pick, and back to the session's own", async () => {
    const { runtime, agy } = setup();
    await runtime.defaults.save({ model: "gemini-3.8-flash", effort: "low" });
    const run = async (text, options) => {
      const message = mention(text, { root: "t", ...options });
      await runtime.run(message.delivery);
      await settle(message);
    };
    const session = () => agy.state.sessions.get("s1");
    await run("one");
    expect(value(session(), "thought_level")).toBe("low");
    await run("two", { model: "claude-opus-4-6-thinking" });
    expect(value(session(), "model")).toBe("claude-opus-4-6-thinking");
    await runtime.defaults.save({ model: "", effort: "" });
    await run("three");
    expect(value(session(), "model")).toBe("gemini-3.8-flash");
    expect(value(session(), "thought_level")).toBe("high");
  });

  it("refuses a synced model Antigravity doesn't offer instead of swapping it", async () => {
    const { runtime, kit } = setup();
    const message = mention("x", { config: { model: "gpt-9" }, synced: { model: "gpt-9" } });
    await runtime.run(message.delivery);
    const result = await settle(message);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/synced model "gpt-9" isn't offered/);
    expect(kit.replies[0]).toMatchObject({ options: { notifyOwner: true } });
  });

  it("starts a new session when instructions change", async () => {
    const { runtime, agy } = setup();
    for (const config of [{}, { instructions: "New role" }]) {
      const message = mention("x", { config });
      await runtime.run(message.delivery);
      await settle(message);
    }
    expect(agy.state.sessions.size).toBe(2);
  });
});

describe("mid-turn messages and Stop", () => {
  it("steers a message into the running turn, which ends with that prompt's answer", async () => {
    const { runtime, agy, script } = setup();
    const { prompt, turns } = agy.hanging();
    script.prompt = prompt;
    const first = mention("count", { root: "t" });
    await runtime.run(first.delivery);
    await tick(20);
    const second = mention("and banana", { root: "t" });
    await runtime.run(second.delivery);
    await tick(20);
    const session = agy.state.sessions.get("s1");
    expect(session.steered?.[0]).toMatch(/<new-message-arrived-while-you-were-working>\nand banana/);
    expect(first.seen.superseded).toBe(1);
    expect(second.seen.acknowledged).toBe(1);
    // The first prompt was answered at once; the turn is still running.
    expect(runtime.sessionState({ key: "agent-1", config: first.delivery.config }, { channelId: "c1", root: "t" })).toBe("active");
    turns[0].finish();
    expect(await first.done()).toEqual({ ok: true });
    expect(await second.done()).toEqual({ ok: true });
  });

  it("queues a message that picks another model", async () => {
    const { runtime, agy, script } = setup();
    const { prompt, turns } = agy.hanging();
    script.prompt = prompt;
    const first = mention("one", { root: "t" });
    await runtime.run(first.delivery);
    await tick(20);
    const second = mention("two", { root: "t", model: "claude-opus-4-6-thinking" });
    await runtime.run(second.delivery);
    await tick(20);
    expect(agy.state.sessions.get("s1").steered).toBeUndefined();
    turns[0].finish();
    await first.done();
    await tick(20);
    turns[1].finish();
    expect(await second.done()).toEqual({ ok: true });
  });

  it("stops the running turn", async () => {
    const { runtime, agy, script } = setup();
    script.prompt = agy.hanging().prompt;
    const message = mention("long");
    await runtime.run(message.delivery);
    await tick(20);
    await message.delivery.stop();
    expect(await message.done()).toEqual({ ok: true, stopped: true });
  });
});

describe("Plan", () => {
  it("declines what would change something, and asks for the plan once when that ended the turn", async () => {
    const script = {};
    const { runtime, agy, host } = setup({ script });
    let asked = 0;
    script.prompt = async (params, { emit, state }) => {
      asked += 1;
      if (asked === 1) {
        // Antigravity asks to run a command, and ends the turn on a no.
        const answer = new Promise((resolve) => (state.permission = resolve));
        emit({
          jsonrpc: "2.0",
          id: 900,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "c", name: "run_command", kind: "execute", title: "touch x" },
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "deny", kind: "reject_once" },
            ],
          },
        });
        await tick(10);
        void answer;
        return { stopReason: "end_turn" };
      }
      await host.servers.at(-1).handler({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "send", arguments: { text: "Plan: …" } } });
      return { stopReason: "end_turn" };
    };
    const message = mention("make x", { root: "t", config: { mode: "plan" } });
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: true });
    const answer = agy.state.calls.find((call) => call.id === 900 && call.result);
    expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "deny" });
    const session = agy.state.sessions.get("s1");
    expect(value(session, "mode")).toBe("plan");
    expect(session.prompts[0]).toMatch(/<plan-mode>/);
    expect(session.prompts[1]).toBe(PLAN_NUDGE);
    expect(session.prompts).toHaveLength(2);
  });
});

describe("failures", () => {
  it("reports a failed turn to the owner and keeps the session", async () => {
    const script = {
      prompt: () => {
        throw new Error("Quota exceeded");
      },
    };
    const { runtime, kit, agy } = setup({ script });
    const message = mention("x");
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: false, error: "Quota exceeded" });
    expect(kit.replies[0].text).toBe("Antigravity (ACP) could not finish: Quota exceeded");
    expect(agy.state.sessions.size).toBe(1);
  });

  it("explains a missing Antigravity CLI", async () => {
    const { runtime, host } = setup();
    host.spawn = async () => {
      throw new Error("program not found");
    };
    const message = mention("x");
    await runtime.run(message.delivery);
    expect((await settle(message)).error).toMatch(/needs Google's Antigravity CLI.*curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/);
  });

  it("recovers a turn whose process died before Antigravity began, by resuming", async () => {
    let crash = true;
    const script = {
      prompt: (params, { session, state }) => {
        if (crash && session.prompts.length === 2) {
          crash = false;
          state.processes.at(-1).crash(1);
          return new Promise(() => {});
        }
        return { stopReason: "end_turn" };
      },
    };
    const { runtime, agy } = setup({ script });
    for (const text of ["one", "two"]) {
      const message = mention(text, { root: "t" });
      await runtime.run(message.delivery);
      expect(await settle(message)).toEqual({ ok: true });
    }
    expect(agy.state.processes).toHaveLength(2);
    expect(calls(agy, "session/resume")).toHaveLength(1);
  });

  it("starts a new session when the saved one is gone", async () => {
    const storage = fakeStorage();
    storage.data.set(`${TYPE}/agent-1`, JSON.stringify({ v: 1, conversations: { c1: { sessionId: "gone", at: 1 } } }));
    const { runtime, agy } = setup({ storage });
    const message = mention("x");
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: true });
    expect(agy.state.sessions.has("s1")).toBe(true);
  });

  it("keeps the saved session when resuming fails for another reason than its loss", async () => {
    const storage = fakeStorage();
    storage.data.set(`${TYPE}/agent-1`, JSON.stringify({ v: 1, conversations: { c1: { sessionId: "kept", at: 1 } } }));
    const script = { "session/resume": () => Promise.reject(Object.assign(new Error("timed out"), { code: -32603 })) };
    const { runtime } = setup({ script, storage });
    const message = mention("x", { config: { scope: "channel" } });
    await runtime.run(message.delivery);
    expect(await settle(message)).toEqual({ ok: false, error: "timed out" });
    await runtime.records.flush();
    expect(JSON.parse(storage.data.get(`${TYPE}/agent-1`)).conversations.c1.sessionId).toBe("kept");
  });

  it("stops quietly, without a failure reply, when the agent is removed mid-turn", async () => {
    const { runtime, agy, script, agents, kit } = setup();
    script.prompt = agy.hanging().prompt;
    const message = mention("long");
    await runtime.run(message.delivery);
    await tick(20);
    agents.running.length = 0;
    runtime.sync();
    expect(await message.done()).toEqual({ ok: true, stopped: true });
    await tick();
    expect(kit.replies).toHaveLength(0);
    expect(agy.state.processes[0].killed).toBe(true);
  });
});

describe("session controls", () => {
  it("New session forgets the session; the next message starts another", async () => {
    const { runtime, agy, storage } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const agent = { key: "agent-1", config: message.delivery.config };
    await runtime.control(agent, { channelId: "c1", root: "t" }, "new");
    await runtime.records.flush();
    expect(JSON.parse(storage.data.get(`${TYPE}/agent-1`)).conversations["c1/t"]).toBeUndefined();
    expect(calls(agy, "session/close")).toHaveLength(1);
    const again = mention("y", { root: "t" });
    await runtime.run(again.delivery);
    await settle(again);
    expect(runtime.agents.get("agent-1").records["c1/t"].sessionId).toBe("s2");
  });

  it("compacts with Antigravity's own /compact", async () => {
    const { runtime, agy } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    await runtime.control({ key: "agent-1", config: message.delivery.config }, { channelId: "c1", root: "t" }, "compact");
    expect(agy.state.sessions.get("s1").prompts.at(-1)).toBe("/compact");
  });

  it("reports state and refuses to compact while busy", async () => {
    const { runtime, agy, script } = setup();
    const { prompt, turns } = agy.hanging();
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
  it("closes an idle session and its MCP server, then resumes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runtime, host, agy } = setup();
    const message = mention("x", { root: "t" });
    await runtime.run(message.delivery);
    await vi.advanceTimersByTimeAsync(50);
    await message.done();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10);
    expect(host.servers[0].open).toBe(false);
    expect(agy.state.processes[0].killed).toBe(true);
    const again = mention("y", { root: "t" });
    await runtime.run(again.delivery);
    await vi.advanceTimersByTimeAsync(50);
    expect(await again.done()).toEqual({ ok: true });
    expect(calls(agy, "session/resume")).toHaveLength(1);
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
  it("runs a timer in a one-off session, closes it, and records its usage", async () => {
    const { runtime, agy, host } = setup();
    const { delivery } = mention("unused");
    const result = await runtime.runOnce({ delivery, key: "timer/1", signal: new AbortController().signal, prompt: async () => "tick" });
    expect(result).toEqual({ ok: true });
    expect(agy.state.sessions.get("s1").prompts[0]).toBe("<timer>tick</timer>");
    expect(agy.state.sessions.get("s1").system).toBe("system");
    expect(calls(agy, "session/close")).toHaveLength(1);
    expect(host.servers[0].open).toBe(false);
    const [usage] = await runtime.usage.read("agent-1", { since: 0 });
    expect(usage).toMatchObject({ id: "s1", wake: "timer/1", gaps: [] });
  });
});

describe("activity and usage", () => {
  it("records each turn's transcript, with posted messages, tools and the outcome", async () => {
    const script = {};
    const { runtime, host } = setup({ script });
    script.prompt = async (params, { update }) => {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "look first" } });
      update({ sessionUpdate: "tool_call", toolCallId: "r", name: "view_file", status: "in_progress", title: "README.md", kind: "read", rawInput: { AbsolutePath: "/w/README.md" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "r", name: "view_file", status: "completed", rawOutput: { output: "# Hi" } });
      update({ sessionUpdate: "tool_call", toolCallId: "s", name: "mcp_buzz_send", status: "in_progress", title: "Run mcp_buzz_send", kind: "other" });
      await tick(5);
      await host.servers.at(-1).handler({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "send", arguments: { text: "Done!" } } });
      return { stopReason: "end_turn" };
    };
    const message = mention("read it", { root: "t" });
    await runtime.run(message.delivery);
    await settle(message);
    const { turns } = await runtime.transcript("agent-1", "c1/t");
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({ channelId: "c1", threadRootId: "t", newSession: true, outcome: "ended" });
    expect(turn.config).toEqual(["Gemini 3.8 Flash", "High thinking", "Bypass permissions"]);
    expect(turn.items.map((item) => item.type)).toEqual(["system", "prompt", "thought", "tool", "message"]);
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
      observations: [{ model: "gemini-3.8-flash", tokens: { input: 200, output: 50, cacheRead: 1000 } }],
    });
  });
});

describe("readiness", () => {
  it("lists each model with its own thinking levels, and the account's plan", async () => {
    const { runtime } = setup();
    const models = await runtime.models({ config: {} });
    expect(models.models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "claude-opus-4-6-thinking"]);
    expect(models.models[0].efforts.map((level) => level.id)).toEqual(["low", "medium", "high"]);
    expect(models.models[1].efforts).toEqual([]);
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "ready", tier: { name: "Google AI Pro" }, canSwitch: true });
  });

  it("asks to sign in, signs in with Google, and switches accounts by signing out first", async () => {
    const { runtime, agy } = setup();
    agy.state.signedIn = false;
    await runtime.catalog.check();
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "attention", attentionLabel: "Sign in to Antigravity", canSignIn: true });
    await expect(runtime.models({ config: {} })).rejects.toThrow(/Sign in to Antigravity/);
    await runtime.catalog.signIn();
    expect(calls(agy, "authenticate")[0].params).toEqual({ methodId: "oauth-personal" });
    expect(runtime.catalog.snapshot()).toMatchObject({ readiness: "ready", signingIn: false });
    await runtime.catalog.signIn({ switching: true });
    expect(calls(agy, "logout")).toHaveLength(1);
    expect(calls(agy, "authenticate")).toHaveLength(2);
  });
});
