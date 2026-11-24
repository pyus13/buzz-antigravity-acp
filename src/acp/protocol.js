// Small, pure pieces of the Agent Client Protocol as Antigravity CLI speaks it.

const EVENT = "buzz-event";
const STEER = "new-message-arrived-while-you-were-working";
const STEER_NOTE =
  "Note: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.";

/** Antigravity's own tools, as Buzz shows them in a step. Its Buzz tools
 * show by their own names (`send`), as Buzz's Claude shows them. */
const TOOL_LABELS = Object.freeze({
  view_file: "Read",
  view_file_outline: "Read",
  view_code_item: "Read",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  run_command: "Shell",
  command_status: "Shell",
  send_command_input: "Shell",
  list_dir: "List",
  find_by_name: "Find",
  grep_search: "Search",
  codebase_search: "Search",
  search_web: "Web search",
  read_url_content: "Fetch",
  browser_subagent: "Browser",
  generate_image: "Image",
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
/** Tool inputs that name what a step acts on, in the order they are tried. */
const STEP_TARGETS = ["AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "Query", "Url", "CommandLine", "path", "query", "url", "command"];
/** Kinds of tool that change something, which Plan never allows. */
const CHANGES = new Set(["edit", "delete", "move", "execute"]);

/** A turn's prompt as a message steered into the running turn, as Buzz's own
 * Claude words it. */
export function steerPrompt(turn) {
  const open = `\n<${EVENT}>\n`;
  const close = `\n</${EVENT}>`;
  const once = (text) => turn.includes(text) && turn.indexOf(text) === turn.lastIndexOf(text);
  const steered =
    once(open) && once(close)
      ? turn.replace(open, `\n<${STEER}>\n`).replace(close, `\n</${STEER}>`)
      : `<${STEER}>\n${turn.trim()}\n</${STEER}>`;
  return `${steered}\n\n${STEER_NOTE}`;
}

/** The tool a `tool_call` (or a permission prompt's `toolCall`) runs, by the
 * name Antigravity gives it. */
export const toolNameOf = (call) => (typeof call?.name === "string" && call.name ? call.name : undefined);

/** A Buzz tool's own name (`send`), when the call is one: Antigravity names
 * an MCP tool by its server and tool. */
export function buzzToolOf(call) {
  const name = toolNameOf(call) ?? "";
  const named = /^(?:mcp[_:]+)?buzz(?:__|_|\/|:|\.)(\w+)$/.exec(name)?.[1];
  if (named) return named;
  const mcp = call?._meta?.antigravity?.mcp ?? call?.rawInput?.__mcp;
  return mcp?.server === "buzz" && typeof mcp.tool === "string" ? mcp.tool : undefined;
}

const short = (text) => {
  const line = String(text).split("\n")[0].trim();
  const tail = line.startsWith("/") ? line.split("/").at(-1) || line : line;
  return tail.length > TARGET_LIMIT ? `${tail.slice(0, TARGET_LIMIT - 1)}…` : tail;
};

/** A `session/update` as the activity step Buzz shows, if it is one. */
export function stepOf(update) {
  switch (update?.sessionUpdate) {
    case "tool_call": {
      const buzz = buzzToolOf(update);
      if (buzz) return { tool: buzz };
      const name = toolNameOf(update);
      const tool = TOOL_LABELS[name] ?? KIND_LABELS[update.kind] ?? (name || "Tool");
      const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
      const target =
        STEP_TARGETS.map((key) => input[key]).find((value) => typeof value === "string" && value) ??
        (typeof update.title === "string" && update.title !== name ? update.title : "");
      return target ? { tool, target: short(target) } : { tool };
    }
    case "agent_thought_chunk":
      return { tool: "Thinking" };
    case "agent_message_chunk":
      return { tool: "Writing reply" };
    default:
      return undefined;
  }
}

/** The answer to `session/request_permission`. Buzz has no one to ask in the
 * middle of a turn, so the agent's permission mode, the owner's choice,
 * decides: in Plan, anything that would change something is declined, so
 * the plan stands and nothing changes; otherwise each tool is allowed once,
 * never "always", which would write a lasting rule into the person's own
 * Antigravity settings. A prompt with no such option is cancelled. */
export function permissionAnswer(params, mode) {
  const options = (Array.isArray(params?.options) ? params.options : []).filter(
    (option) => typeof option?.optionId === "string",
  );
  const select = (option) =>
    option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  const call = params?.toolCall;
  if (mode === "plan" && !buzzToolOf(call) && CHANGES.has(call?.kind))
    return select(options.find((option) => String(option.kind).startsWith("reject")));
  return select(options.find((option) => option.kind === "allow_once"));
}

/** Every choice of a select config option, groups flattened. */
export const choicesOf = (options = []) =>
  (Array.isArray(options) ? options : []).flatMap((option) =>
    Array.isArray(option?.options)
      ? choicesOf(option.options)
      : typeof option?.value === "string"
        ? [{ value: option.value, name: option.name || option.value, description: option.description }]
        : [],
  );

/** A session's config option for `category` (`model`, `thought_level`,
 * `mode`), by its category, else its id. */
export const optionOf = (configOptions, category) =>
  Array.isArray(configOptions)
    ? (configOptions.find((option) => option?.category === category) ?? configOptions.find((option) => option?.id === category))
    : undefined;

/** The plan an answer says the signed-in account is on, if it says. */
export function tierOf(answer) {
  const tier = answer?._meta?.antigravity?.tier;
  return tier && typeof tier === "object" && typeof tier.name === "string"
    ? { id: typeof tier.id === "string" ? tier.id : "", name: tier.name, ...(typeof tier.upgradeUri === "string" ? { upgradeUri: tier.upgradeUri } : {}) }
    : undefined;
}

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** A `session/prompt` answer's token use, as a Buzz usage observation.
 * Antigravity counts cached tokens inside its input and thinking apart from
 * its output; Buzz counts input without the cached part, and thinking as
 * output, as it is billed. */
export function observationsOf(answer, model, at = Date.now()) {
  const usage = answer?.usage;
  if (!usage || typeof usage !== "object") return [];
  const input = count(usage.inputTokens);
  const cacheRead = Math.min(count(usage.cachedReadTokens), input);
  const cacheWrite = count(usage.cachedWriteTokens);
  const output = count(usage.outputTokens) + count(usage.thoughtTokens);
  if (!input && !output) return [];
  return [
    {
      at,
      model: model || "antigravity",
      tokens: {
        input: Math.max(0, input - cacheRead),
        output,
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
      },
    },
  ];
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

/** Whether an error says Antigravity has no usable sign-in. */
export const needsSignIn = (error) => error?.code === -32000 || /authentication required|not (signed|logged) in/i.test(errorText(error));

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
