import { describe, expect, it } from "vitest";
import { modelsOf, observationsOf, permissionAnswer, promptSections, stepOf, toolNameOf } from "../src/acp/protocol.js";

describe("stepOf", () => {
  it("names Gemini's tools and Buzz's, and what they act on", () => {
    const call = (toolCallId, title, kind = "other") => stepOf({ sessionUpdate: "tool_call", toolCallId, title, kind });
    expect(call("mcp_buzz_send_1732000000000_0", "send(final: true)")).toEqual({ tool: "send" });
    expect(call("read_file_1732000000000_1", "/a/b/c.ts", "read")).toEqual({ tool: "Read", target: "c.ts" });
    expect(call("run_shell_command_1732000000000_2", "npm test", "execute")).toEqual({ tool: "Shell", target: "npm test" });
    // A call id the model gave says nothing: the kind does.
    expect(call("abc", "src/x.js", "edit")).toEqual({ tool: "Edit", target: "src/x.js" });
    expect(call("run_shell_command_1732000000000_3", "x".repeat(200)).target).toHaveLength(80);
  });

  it("shows thinking and writing, but not mode notes", () => {
    expect(stepOf({ sessionUpdate: "agent_thought_chunk" })).toEqual({ tool: "Thinking" });
    expect(stepOf({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toEqual({ tool: "Writing reply" });
    expect(stepOf({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[MODE_UPDATE] yolo" } })).toBeUndefined();
    expect(stepOf({ sessionUpdate: "usage_update" })).toBeUndefined();
  });

  it("knows Buzz's message tools by title when the call id doesn't say", () => {
    expect(toolNameOf({ toolCallId: "synth_p1_1732000000000_0", title: "send(final: true)" })).toBe("mcp_buzz_send");
    expect(toolNameOf({ toolCallId: "x", _meta: { "gemini-cli": { mcp: { server_name: "buzz", tool_name: "react" } } } })).toBe("mcp_buzz_react");
  });
});

describe("permissionAnswer", () => {
  const selected = (optionId) => ({ outcome: { outcome: "selected", optionId } });
  const options = [
    { optionId: "proceed_always", kind: "allow_always" },
    { optionId: "proceed_once", kind: "allow_once" },
    { optionId: "cancel", kind: "reject_once" },
  ];
  const ask = (toolCallId, mode, kind = "edit") => permissionAnswer({ options, toolCall: { toolCallId, kind } }, mode);

  it("allows once, so no lasting rule is written to the person's settings", () => {
    expect(ask("write_file_1732000000000_0", "acceptEdits")).toEqual(selected("proceed_once"));
    expect(permissionAnswer({ options: [options[0]] }, "default")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("keeps a plan in Plan, and leaves plan mode in other modes", () => {
    expect(ask("exit_plan_mode_1732000000000_0", "plan", "other")).toEqual(selected("cancel"));
    expect(ask("x", "plan", "switch_mode")).toEqual(selected("cancel"));
    expect(ask("exit_plan_mode_1732000000000_0", "bypassPermissions", "other")).toEqual(selected("proceed_once"));
  });

  it("declines Gemini's own questions: the agent asks in Buzz", () => {
    expect(ask("ask_user_1732000000000_0", "bypassPermissions", "other")).toEqual(selected("cancel"));
  });
});

describe("models", () => {
  it("reads Gemini's models and the one it starts on", () => {
    expect(
      modelsOf({ models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }, { modelId: "gemini-2.5-pro" }, {}] } }),
    ).toEqual({
      current: "auto",
      choices: [
        { value: "auto", name: "Auto", description: undefined },
        { value: "gemini-2.5-pro", name: "gemini-2.5-pro", description: undefined },
      ],
    });
  });
});

describe("observationsOf", () => {
  it("counts input without its cached part, and thinking as output", () => {
    const answer = {
      usage: { inputTokens: 1200, outputTokens: 40, cachedReadTokens: 1000, thoughtTokens: 10 },
      _meta: { quota: { model_usage: [{ model: "gemini-3-pro-preview", token_count: { input_tokens: 1200, output_tokens: 40 } }] } },
    };
    expect(observationsOf(answer, "auto", 5)).toEqual([
      { at: 5, model: "gemini-3-pro-preview", tokens: { input: 200, output: 50, cacheRead: 1000 } },
    ]);
  });

  it("splits a turn Auto routed between models", () => {
    const answer = {
      usage: { inputTokens: 1100, outputTokens: 30, cachedReadTokens: 500 },
      _meta: {
        quota: {
          model_usage: [
            { model: "gemini-2.5-flash", token_count: { input_tokens: 100, output_tokens: 10 } },
            { model: "gemini-3-pro-preview", token_count: { input_tokens: 1000, output_tokens: 20 } },
          ],
        },
      },
    };
    expect(observationsOf(answer, "auto", 1)).toEqual([
      { at: 1, model: "gemini-2.5-flash", tokens: { input: 100, output: 10 } },
      { at: 1, model: "gemini-3-pro-preview", tokens: { input: 500, output: 20, cacheRead: 500 } },
    ]);
  });

  it("records nothing for a turn that used no tokens", () => {
    expect(observationsOf({ stopReason: "cancelled" })).toEqual([]);
    expect(observationsOf({ usage: { inputTokens: 0, outputTokens: 0 } })).toEqual([]);
  });
});

describe("promptSections", () => {
  it("splits top-level framing, keeping loose text as its own section", () => {
    expect(promptSections("intro\n<buzz-event>\nhello\n</buzz-event>\n<owner-section>\nx")).toEqual([
      { tag: "buzz-event", body: "hello" },
      { tag: "text", body: "intro\n<owner-section>\nx" },
    ]);
  });
});
