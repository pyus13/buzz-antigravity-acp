import { describe, expect, it, vi } from "vitest";
import { AcpConnection } from "../src/acp/connection.js";
import { fakeAdapter, fakeHost, NO_REPLY } from "./fake-host.js";

const initialized = {
  protocolVersion: 1,
  agentInfo: { name: "Antigravity ACP Server" },
  authMethods: [{ id: "oauth-personal" }],
  agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, auth: { logout: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } },
};

describe("AcpConnection", () => {
  it("starts with a scrubbed environment and completes the handshake", async () => {
    const adapter = fakeAdapter({ initialize: () => initialized });
    const host = fakeHost(adapter);
    const connection = await AcpConnection.start(host, { cwd: "/w" });
    expect(host.spawned[0].id).toBe("agy");
    const { env } = host.spawned[0].options;
    // The person's own Google sign-in, never an API key or Vertex AI.
    expect(env.GEMINI_API_KEY).toBeNull();
    expect(env.GOOGLE_API_KEY).toBeNull();
    expect(env.AGY_ADC_AUTH).toBeNull();
    expect(host.spawned[0].options.agentCredential).toBeUndefined();
    expect(connection.canSteer).toBe(true);
    expect(connection.appendsSystemPrompt).toBe(true);
    expect(connection.offersGoogleLogin).toBe(true);
    expect(connection.canLogOut).toBe(true);
  });

  it("binds the agent's credential when the host offers it", async () => {
    const adapter = fakeAdapter({ initialize: () => initialized });
    const actAs = vi.fn(async () => {});
    const host = fakeHost(adapter);
    const spawn = host.spawn;
    host.spawn = async (...args) => Object.assign(await spawn(...args), { actAs });
    await AcpConnection.start(host, { cwd: "/w", agent: { pubkey: "p", relay: "wss://r" } });
    expect(host.spawned[0].options.agentCredential).toBe(true);
    expect(actAs).toHaveBeenCalledWith({ pubkey: "p", relay: "wss://r" });
  });

  it("stops a process whose handshake fails", async () => {
    const adapter = fakeAdapter({
      initialize: () => {
        throw new Error("unsupported version");
      },
    });
    await expect(AcpConnection.start(fakeHost(adapter), { cwd: "/w" })).rejects.toThrow("unsupported version");
    expect(adapter.process.killed).toBe(true);
  });

  it("explains a missing Antigravity CLI, with how to install it", async () => {
    const host = { spawn: async () => Promise.reject(new Error("program not found")) };
    await expect(AcpConnection.start(host, { cwd: "/w" })).rejects.toThrow(
      /needs Google's Antigravity CLI on this computer\. Install it in a terminal with curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/,
    );
  });

  it("routes updates to their session and answers Antigravity's requests", async () => {
    const adapter = fakeAdapter({ initialize: () => initialized });
    const connection = await AcpConnection.start(fakeHost(adapter), { cwd: "/w" });
    const updates = [];
    connection.onSession("s1", (update) => updates.push(update));
    adapter.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "x" } } });
    adapter.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: { sessionUpdate: "y" } } });
    adapter.emit({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { options: [{ kind: "allow_once", optionId: "ok" }] } });
    adapter.emit({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates).toEqual([{ sessionUpdate: "x" }]);
    expect(adapter.sent.find((m) => m.id === 7).result).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(adapter.sent.find((m) => m.id === 8).error.code).toBe(-32601);
  });

  it("fails pending requests when the process exits, and says so", async () => {
    const adapter = fakeAdapter({ initialize: () => initialized, "session/prompt": () => NO_REPLY });
    const connection = await AcpConnection.start(fakeHost(adapter), { cwd: "/w" });
    const closes = [];
    connection.onClose((reason, stopped) => closes.push({ reason, stopped }));
    const prompt = connection.request("session/prompt", {});
    connection.stderr = "fatal: out of memory\n";
    adapter.process.exit(1);
    await expect(prompt).rejects.toThrow(/stopped with exit code 1:\nfatal: out of memory/);
    expect(closes).toEqual([{ reason: expect.stringContaining("exit code 1"), stopped: false }]);
    await expect(connection.request("session/new", {})).rejects.toThrow(/stopped/);
  });

  it("reports its own stop as stopped", async () => {
    const adapter = fakeAdapter({ initialize: () => initialized });
    const connection = await AcpConnection.start(fakeHost(adapter), { cwd: "/w" });
    const closes = [];
    connection.onClose((reason, stopped) => closes.push(stopped));
    await connection.stop();
    expect(closes).toEqual([true]);
    expect(adapter.process.killed).toBe(true);
  });

  it("times out a request Antigravity never answers", async () => {
    vi.useFakeTimers();
    try {
      const adapter = fakeAdapter({ initialize: () => initialized, "session/new": () => NO_REPLY });
      const starting = AcpConnection.start(fakeHost(adapter), { cwd: "/w" });
      await vi.advanceTimersByTimeAsync(1);
      const connection = await starting;
      const request = connection.request("session/new", {}, 1000);
      const settled = expect(request).rejects.toThrow(/did not answer session\/new in time/);
      await vi.advanceTimersByTimeAsync(1001);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
