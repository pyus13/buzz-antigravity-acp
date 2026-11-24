import { describe, expect, it } from "vitest";
import { buzzToolOf, observationsOf, optionOf, permissionAnswer, promptSections, steerPrompt, stepOf, tierOf } from "../src/acp/protocol.js";

describe("steerPrompt", () => {
  it("renames the event section and adds the note", () => {
    const steered = steerPrompt("context\n<buzz-event>\nhello\n</buzz-event>");
    expect(steered).toContain("<new-message-arrived-while-you-were-working>\nhello\n</new-message-arrived-while-you-were-working>");
    expect(steered).toMatch(/A new message arrived while you were working/);
  });
});

describe("stepOf", () => {
  const call = (name, extra = {}) => stepOf({ sessionUpdate: "tool_call", name, ...extra });
  it("names Antigravity's tools and Buzz's, and what they act on", () => {
    expect(call("mcp_buzz_send", { title: "Run mcp_buzz_send", kind: "other" })).toEqual({ tool: "send" });
    expect(call("view_file", { kind: "read", rawInput: { AbsolutePath: "/a/b/c.ts" } })).toEqual({ tool: "Read", target: "c.ts" });
    expect(call("run_command", { kind: "execute", rawInput: { CommandLine: "npm test" } })).toEqual({ tool: "Shell", target: "npm test" });
    expect(call("something_new", { kind: "edit", title: "x.js" })).toEqual({ tool: "Edit", target: "x.js" });
    expect(call("run_command", { rawInput: { CommandLine: "x".repeat(200) } }).target).toHaveLength(80);
  });

  it("shows thinking and writing, and nothing else", () => {
    expect(stepOf({ sessionUpdate: "agent_thought_chunk" })).toEqual({ tool: "Thinking" });
    expect(stepOf({ sessionUpdate: "agent_message_chunk" })).toEqual({ tool: "Writing reply" });
    expect(stepOf({ sessionUpdate: "usage_update" })).toBeUndefined();
  });

  it("knows Buzz's tools by Antigravity's MCP names", () => {
    expect(buzzToolOf({ name: "mcp_buzz_reply_in_subthread" })).toBe("reply_in_subthread");
    expect(buzzToolOf({ name: "mcp_github_search" })).toBeUndefined();
  });
});

describe("permissionAnswer", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  const selected = (optionId) => ({ outcome: { outcome: "selected", optionId } });
  const ask = (toolCall, mode) => permissionAnswer({ options, toolCall }, mode);

  it("allows once, so no lasting rule is written to the person's settings", () => {
    expect(ask({ name: "run_command", kind: "execute" }, "bypassPermissions")).toEqual(selected("allow"));
    expect(permissionAnswer({ options: [{ optionId: "always", kind: "allow_always" }] }, "auto")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("in Plan, declines what would change something, but not reading or Buzz's tools", () => {
    expect(ask({ name: "run_command", kind: "execute" }, "plan")).toEqual(selected("deny"));
    expect(ask({ name: "write_to_file", kind: "edit" }, "plan")).toEqual(selected("deny"));
    expect(ask({ name: "view_file", kind: "read" }, "plan")).toEqual(selected("allow"));
    expect(ask({ name: "mcp_buzz_send", kind: "other" }, "plan")).toEqual(selected("allow"));
  });
});

describe("session details", () => {
  it("finds config options by category", () => {
    const options = [{ id: "thinking", category: "thought_level" }, { id: "model" }];
    expect(optionOf(options, "thought_level").id).toBe("thinking");
    expect(optionOf(options, "model").id).toBe("model");
    expect(optionOf(undefined, "model")).toBeUndefined();
  });

  it("reads the account's plan", () => {
    expect(tierOf({ _meta: { antigravity: { tier: { id: "free-tier", name: "Antigravity Starter Quota", upgradeUri: "u" } } } })).toEqual({
      id: "free-tier",
      name: "Antigravity Starter Quota",
      upgradeUri: "u",
    });
    expect(tierOf({})).toBeUndefined();
  });
});

describe("observationsOf", () => {
  it("counts input without its cached part, and thinking as output", () => {
    const answer = { usage: { inputTokens: 21080, outputTokens: 783, cachedReadTokens: 16189, cachedWriteTokens: 0, thoughtTokens: 718 } };
    expect(observationsOf(answer, "gemini-3.8-flash", 5)).toEqual([
      { at: 5, model: "gemini-3.8-flash", tokens: { input: 4891, output: 1501, cacheRead: 16189 } },
    ]);
  });

  it("records nothing for a turn that used no tokens", () => {
    expect(observationsOf({ stopReason: "end_turn" })).toEqual([]);
  });
});

describe("promptSections", () => {
  it("splits top-level framing, keeping loose text as its own section", () => {
    expect(promptSections("intro\n<buzz-event>\nhello\n</buzz-event>")).toEqual([
      { tag: "buzz-event", body: "hello" },
      { tag: "text", body: "intro" },
    ]);
  });
});
