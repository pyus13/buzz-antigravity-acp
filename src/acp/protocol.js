// Small, pure pieces of the Agent Client Protocol as Gemini CLI speaks it.

/** Gemini CLI's own tools, as Buzz shows them in a step. Its Buzz tools are
 * `mcp_buzz_<tool>` and show as `<tool>`, as Buzz's other harnesses show them. */
const TOOL_LABELS = Object.freeze({
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
  activate_skill: "Skill",
});
const KIND_LABELS = Object.freeze({
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Shell",
  think: "Thinking",
  fetch: "Fetch",
  switch_mode: "Plan",
});
const TARGET_LIMIT = 80;
/** Said in the session when its approval mode changes, not meant for anyone. */
const MODE_NOTE = /^\[MODE_UPDATE\]/;

/** The tool a `tool_call` (or a permission prompt's `toolCall`) runs, by its
 * Gemini name: from the server and tool an MCP prompt names, else from its
 * call id, which Gemini makes as `<tool>_<time>_<n>` when the model gives
 * none. Undefined when neither says. */
export function toolNameOf(call) {
  const mcp = call?._meta?.["gemini-cli"]?.mcp;
  if (typeof mcp?.server_name === "string" && typeof mcp?.tool_name === "string")
    return `mcp_${mcp.server_name}_${mcp.tool_name}`;
  const id = typeof call?.toolCallId === "string" ? call.toolCallId : "";
  const named = /^(.+?)[_-]\d{10,}[_-]\d+$/.exec(id)?.[1];
  if (named && !named.startsWith("synth_")) return named;
  // An MCP tool's title is `<tool>(<arguments>)`; Buzz's message tools are
  // known by theirs when the call id doesn't say.
  const message = /^(send|reply_in_subthread)\(/.exec(typeof call?.title === "string" ? call.title : "")?.[1];
  return message ? `mcp_buzz_${message}` : undefined;
}

/** A Buzz tool's own name (`send`), when `name` is one. */
export const buzzToolOf = (name) => (typeof name === "string" ? /^mcp_buzz_(\w+)$/.exec(name)?.[1] : undefined);

const short = (text) => {
  const line = text.split("\n")[0].trim();
  const tail = line.startsWith("/") ? line.split("/").at(-1) || line : line;
  return tail.length > TARGET_LIMIT ? `${tail.slice(0, TARGET_LIMIT - 1)}…` : tail;
};

/** A `session/update` as the activity step Buzz shows, if it is one. */
export function stepOf(update) {
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
      return MODE_NOTE.test(update.content?.text ?? "") ? undefined : { tool: "Writing reply" };
    default:
      return undefined;
  }
}

/** Whether an agent message chunk only reports a mode change. */
export const modeNote = (update) => MODE_NOTE.test(update?.content?.text ?? "");

/** The answer to `session/request_permission`. Buzz has no one to ask in the
 * middle of a turn, so the agent's permission mode, the owner's choice,
 * decides:
 * - Gemini's own question tool is declined: the agent asks in Buzz instead.
 * - In Plan, leaving plan mode is declined, so the plan stands and changes
 *   nothing; anything else Gemini still asks about is allowed once.
 * - Anything else is allowed once, never "always": that could write a lasting
 *   allow rule into the person's own Gemini settings.
 * A prompt with no such option is cancelled. */
export function permissionAnswer(params, mode) {
  const options = (Array.isArray(params?.options) ? params.options : []).filter(
    (option) => typeof option?.optionId === "string",
  );
  const select = (option) =>
    option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  const reject = () => select(options.find((option) => String(option.kind).startsWith("reject")));
  const name = toolNameOf(params?.toolCall);
  const leavesPlan = name === "exit_plan_mode" || params?.toolCall?.kind === "switch_mode";
  if (name === "ask_user") return reject();
  if (leavesPlan && (mode === "plan" || !mode)) return reject();
  return select(options.find((option) => option.kind === "allow_once"));
}

/** The models a `session/new` or `session/load` answer offers, and the one
 * the session runs on. */
export function modelsOf(answer) {
  const models = Array.isArray(answer?.models?.availableModels) ? answer.models.availableModels : [];
  return {
    current: typeof answer?.models?.currentModelId === "string" ? answer.models.currentModelId : undefined,
    choices: models
      .filter((model) => typeof model?.modelId === "string" && model.modelId)
      .map((model) => ({
        value: model.modelId,
        name: typeof model.name === "string" && model.name ? model.name : model.modelId,
        description: typeof model.description === "string" && model.description ? model.description : undefined,
      })),
  };
}

/** The approval modes a session offers, and the one it runs in. */
export function modesOf(answer) {
  const modes = Array.isArray(answer?.modes?.availableModes) ? answer.modes.availableModes : [];
  return {
    current: typeof answer?.modes?.currentModeId === "string" ? answer.modes.currentModeId : undefined,
    ids: modes.map((mode) => mode?.id).filter((id) => typeof id === "string"),
  };
}

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** A `session/prompt` answer's token use, as Buzz's usage observations, one
 * per model the turn used. Gemini counts cached tokens inside its input and
 * thinking apart from its output; Buzz counts input without the cached part,
 * and thinking as output, as it is billed. */
export function observationsOf(answer, fallbackModel, at = Date.now()) {
  const usage = answer?.usage;
  if (!usage || typeof usage !== "object") return [];
  const input = count(usage.inputTokens);
  const cached = Math.min(count(usage.cachedReadTokens), input);
  const output = count(usage.outputTokens) + count(usage.thoughtTokens);
  if (!input && !output) return [];
  const perModel = (Array.isArray(answer?._meta?.quota?.model_usage) ? answer._meta.quota.model_usage : []).filter(
    (entry) => typeof entry?.model === "string" && entry.model,
  );
  const tokens = (inputCount, outputCount, cache) => ({
    input: Math.max(0, inputCount - cache),
    output: outputCount,
    ...(cache ? { cacheRead: cache } : {}),
  });
  if (perModel.length <= 1)
    return [{ at, model: perModel[0]?.model ?? fallbackModel ?? "gemini", tokens: tokens(input, output, cached) }];
  // Several models in one turn (Auto routes between them): each its own
  // counts, the cache and thinking with the one that used the most input.
  const largest = perModel.reduce((top, entry) =>
    count(entry.token_count?.input_tokens) > count(top.token_count?.input_tokens) ? entry : top,
  );
  return perModel.map((entry) => {
    const own = entry === largest;
    const entryInput = count(entry.token_count?.input_tokens);
    const entryOutput = count(entry.token_count?.output_tokens) + (own ? count(usage.thoughtTokens) : 0);
    return { at, model: entry.model, tokens: tokens(entryInput, entryOutput, own ? Math.min(cached, entryInput) : 0) };
  });
}

/** A JSON-RPC error, a thrown error or anything else, as one line of text. */
export function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const data = typeof error.data === "string" ? error.data : error.data?.message;
    return data ? `${error.message}: ${data}` : String(error.message);
  }
  return String(error);
}

/** Whether an error says Gemini has no usable sign-in. */
export const needsSignIn = (error) =>
  /auth(entication)? required|api key is missing|not configured|login required|sign.?in|credentials|unauthenticated|invalid_grant|-32000/i.test(
    errorText(error),
  ) || error?.code === -32000;

export const lastLines = (text, count = 6) => text.trim().split("\n").slice(-count).join("\n");

/** Thinking ids as Buzz labels them. */
export const effortLabel = (id) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/** Top-level `<tag>` … `</tag>` framing in a prompt, as Buzz's transcript
 * shows it; text outside any is its `text` section. */
export function promptSections(text) {
  const sections = [];
  const loose = [];
  let open;
  for (const line of String(text).split("\n")) {
    if (open) {
      if (line === `</${open.tag}>`) {
        sections.push({ tag: open.tag, body: open.lines.join("\n") });
        open = undefined;
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
