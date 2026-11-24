// One Buzz conversation (a thread, or a whole channel) and the Antigravity
// session that continues it: its turns run one at a time, a message that
// arrives mid-turn is steered into it, and an idle session closes until it
// is needed.
import { choicesOf, errorText, observationsOf, optionOf, steerPrompt, stepOf, tierOf } from "../acp/protocol.js";
import { agentMode, CLOSE_TIMEOUT_MS, IDLE_MS, MODES, START_TIMEOUT_MS, TITLE } from "../constants.js";
import { sessionShape } from "../config.js";

export const STOPPED = Object.freeze({ ok: true, stopped: true });
/** How long a reset waits for a cancelled turn to end before closing. */
const SETTLE_MS = 5_000;
const EVENT_ID = /\b[0-9a-f]{64}\b/;
const MESSAGE_TOOLS = new Set(["send", "reply_in_subthread"]);
/** Told with each turn in Plan, where Buzz declines anything that would
 * change something: Antigravity's own plan mode doesn't post its plan. */
export const PLAN_NOTE = `<plan-mode>
You are in plan mode. Research and plan only: read files and search, but don't create, edit, move or delete files or run commands that change anything; Buzz declines them. When your plan is ready, post it with Buzz's send tool.
</plan-mode>`;
/** Sent when a turn in Plan ended on a declined tool with no plan posted:
 * Antigravity ends a turn when a tool is declined. */
export const PLAN_NUDGE = `<plan-mode>
That was declined: you are in plan mode, and nothing may change. Don't try it again. Post your plan now with Buzz's send tool.
</plan-mode>`;
/** A turn's prompt text, with the plan note in Plan. */
export const turnText = (text, mode) => (mode === "plan" ? `${text}\n\n${PLAN_NOTE}` : text);
/** Updates that come with a session, not from a turn Antigravity began. */
const AMBIENT = new Set(["available_commands_update", "current_mode_update", "config_option_update", "usage_update"]);

/** The `session/new` and `session/resume` parameters for a session in `cwd`
 * whose Buzz tools `mcp` serves, with Buzz's system prompt after
 * Antigravity's own. */
export function sessionParams(cwd, mcp, system) {
  return {
    cwd,
    mcpServers: [{ type: "http", name: "buzz", url: mcp.url, headers: mcp.headers.map((header) => ({ ...header })) }],
    ...(system ? { _meta: { antigravity: { systemPrompt: { append: system } } } } : {}),
  };
}

/** Sets a session's options where they differ from `wanted`
 * (`[category, value, synced]`). An option the session lacks, or a value it
 * does not offer, is left alone, except a synced one, which stops the turn
 * (NIP-AP: never replace a synced setting with a default). Returns the
 * session's options after. */
export async function applyOptions(connection, sessionId, configOptions, wanted) {
  let options = configOptions;
  for (const [category, value, synced] of wanted) {
    const option = optionOf(options, category);
    if (!option || !value || option.currentValue === value) continue;
    if (!choicesOf(option.options).some((choice) => choice.value === value)) {
      if (synced)
        throw new Error(
          `This agent's synced ${category === "thought_level" ? "thinking" : category} "${value}" isn't offered by ${TITLE}. Change it in Settings.`,
        );
      continue;
    }
    const changed = await connection.request(
      "session/set_config_option",
      { sessionId, configId: option.id, value },
      START_TIMEOUT_MS,
    );
    options = Array.isArray(changed?.configOptions)
      ? changed.configOptions
      : options.map((item) => (item.id === option.id ? { ...item, currentValue: value } : item));
  }
  return options;
}

/** The options a turn runs with: a per-message pick, else the agent's own
 * setting, else this device's default, else the session's own. Only a value
 * the agent's synced settings chose counts as synced. */
export function wantedOptions(delivery, settings, defaults, session = {}) {
  const synced = delivery.synced ?? {};
  const effective = defaults.effective(settings);
  const model = delivery.model || (effective.model === "default" ? session.model : effective.model);
  const effort = delivery.effort || (delivery.model ? "" : effective.effort === "default" ? "" : effective.effort);
  return [
    ["mode", agentMode(settings.mode), "mode" in synced],
    ["model", model, !delivery.model && Boolean(settings.model) && "model" in synced],
    // A model takes the thinking level asked for, else the one it started on.
    ["thought_level", effort || session.effort, !delivery.effort && Boolean(settings.effort) && "effort" in synced],
  ];
}

/** What a turn's `stopReason` means for Buzz. */
export function outcomeOf(stopReason) {
  if (stopReason === "cancelled") return STOPPED;
  if (stopReason === "refusal") return { ok: false, error: "Antigravity declined to continue this turn." };
  if (stopReason === "max_tokens")
    return { ok: false, error: "Antigravity's context window is full. Compact the session or start a new one." };
  if (stopReason === "max_turn_requests") return { ok: false, error: "Antigravity stopped this turn: it reached its turn limit." };
  return { ok: true };
}

const transcriptOutcome = (result) => (result.stopped ? "stopped" : result.ok ? "ended" : "error");

/** Whether a failed prompt left the session unusable, so the next turn should
 * open it again (Antigravity resumes it from its own history). */
const sessionLost = (error, connection) =>
  Boolean(connection?.closed) || /session has ended|exited unexpectedly|not found|unknown session|no such session/i.test(errorText(error));

/** Whether `session/resume` failed because Antigravity no longer has it. */
const sessionGone = (error) => error?.code === -32002 || /not found|unknown session|no such session|does not exist/i.test(errorText(error));

class Turn {
  constructor(delivery, { compacting = false } = {}) {
    this.receipts = delivery ? [delivery] : [];
    this.compacting = compacting;
    /** Whether the session reported anything, so the turn began. */
    this.updated = false;
    this.named = false;
    this.step = "";
    /** Whether a message was posted, and whether Buzz declined a tool. */
    this.posted = false;
    this.declined = false;
    /** The prompt request the turn ends with: a steered message's, once one
     * joins it, as Antigravity then answers the earlier one at once. */
    this.request = undefined;
    this.record = undefined;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  get latest() {
    return this.receipts.at(-1);
  }
}

export class Conversation {
  constructor(agent, key, record) {
    this.agent = agent;
    this.key = key;
    /** `{ sessionId, cursor?, shape?, whole?, where?, at }`, or undefined. */
    this.record = record;
    this.connection = undefined;
    this.live = false;
    this.options = undefined;
    /** The model and thinking level the session started on: its defaults. */
    this.started = {};
    this.mcp = undefined;
    this.handler = undefined;
    this.unsubscribe = undefined;
    /** The turn Antigravity is running, or a compaction. */
    this.turn = undefined;
    /** The queued item being prepared to run, until its turn starts. */
    this.starting = undefined;
    this.queue = [];
    this.pumping = false;
    this.steering = Promise.resolve();
    this.idleTimer = undefined;
    /** The permission mode the session runs in, for its permission prompts. */
    this.mode = undefined;
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

  /** Runs a mention or wake in this conversation: steered into the running
   * turn when it can be, else queued as the next turn. */
  async deliver(delivery, conversation, settings) {
    this.used = Date.now();
    this.wholeNow = conversation.key === conversation.channel;
    if (typeof conversation.where === "string") this.where = conversation.where;
    if (await this.trySteer(delivery, conversation)) return;
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

  /** Steers one message at a time, so each sees the last one's cursor. */
  trySteer(delivery, conversation) {
    const attempt = this.steering.then(() => this.steer(delivery, conversation));
    this.steering = attempt.catch(() => false);
    return attempt;
  }

  /** Antigravity takes a prompt sent while a turn runs into that turn, and
   * answers the turn's earlier prompt at once: the turn then ends with this
   * one's answer. */
  async steer(delivery, conversation) {
    const turn = this.turn;
    // A message that picks another model or level runs as its own turn.
    if (!turn?.request || turn.compacting || !this.live || !this.connection.canSteer || delivery.model || delivery.effort)
      return false;
    let prompt;
    try {
      prompt = await this.agent.kit.turnPrompt(delivery, conversation, this.cursorOption());
    } catch (error) {
      console.warn("antigravity-acp: could not build a steered prompt", error);
      return false;
    }
    if (this.turn !== turn || !this.live) {
      prompt.restore();
      return false;
    }
    const text = turnText(steerPrompt(prompt.text), this.mode);
    turn.request = this.connection.request("session/prompt", {
      sessionId: this.record.sessionId,
      prompt: [{ type: "text", text }],
    });
    this.record.cursor = prompt.cursor;
    this.save();
    turn.record?.prompt(delivery, text, true);
    turn.latest?.superseded?.();
    turn.receipts.push(delivery);
    turn.step = "";
    delivery.acknowledged?.();
    delivery.workingUntil(turn.done);
    delivery.interruptible?.(async () => this.stop());
    return true;
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
        const result = await this.runTurn(item).catch((error) =>
          this.agent.disposed ? STOPPED : { ok: false, error: errorText(error) },
        );
        this.starting = undefined;
        item.resolve(result);
        if (!result.ok && result.error) await this.agent.report(item, result.error);
      }
    } finally {
      this.pumping = false;
      this.starting = undefined;
      this.scheduleIdle();
      this.agent.changed();
    }
  }

  /** Waits for the turn's last prompt, and records the token use of each. */
  async settle(turn, conversation) {
    for (;;) {
      const request = turn.request;
      const answer = await request;
      void this.agent.recordUsage({
        sessionId: this.record?.sessionId,
        channelId: conversation?.channel,
        root: conversation?.root,
        observations: observationsOf(answer, optionOf(this.options, "model")?.currentValue),
      });
      if (turn.request === request) return answer;
    }
  }

  async runTurn(item, retried = false) {
    const { delivery, conversation, settings } = item;
    await this.open(delivery, conversation, settings);
    if (item.stopped) return STOPPED;
    this.options = await applyOptions(
      this.connection,
      this.record.sessionId,
      this.options,
      wantedOptions(delivery, settings, this.agent.defaults, this.started),
    );
    this.mode = settings.mode;
    if (item.stopped) return STOPPED;
    const before = this.record.cursor;
    const prompt = await this.agent.kit.turnPrompt(delivery, conversation, this.cursorOption());
    if (item.stopped) {
      prompt.restore();
      return STOPPED;
    }
    const turn = new Turn(delivery);
    const { connection } = this;
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId: this.record.sessionId,
      newSession: Boolean(this.fresh),
      channelId: conversation.channel,
      root: conversation.root,
      delivery,
      system: this.fresh ? this.system : undefined,
      prompt: prompt.text,
      config: this.configLabels(),
    });
    this.fresh = false;
    this.turn = turn;
    this.starting = undefined;
    this.agent.changed();
    let result;
    try {
      turn.request = connection.request("session/prompt", {
        sessionId: this.record.sessionId,
        prompt: [{ type: "text", text: turnText(prompt.text, settings.mode) }],
      });
      // Saved once sent: the session has been shown it.
      this.record.cursor = prompt.cursor;
      this.save();
      delivery.acknowledged?.();
      let answer = await this.settle(turn, conversation);
      // A plan that ended on a declined tool is asked for, once.
      if (settings.mode === "plan" && answer?.stopReason === "end_turn" && turn.declined && !turn.posted && this.live) {
        turn.declined = false;
        turn.record.prompt(delivery, PLAN_NUDGE, true);
        turn.request = connection.request("session/prompt", {
          sessionId: this.record.sessionId,
          prompt: [{ type: "text", text: PLAN_NUDGE }],
        });
        answer = await this.settle(turn, conversation);
      }
      result = outcomeOf(answer?.stopReason);
    } catch (error) {
      if (!turn.updated) {
        // Antigravity never began: the next prompt shows the same messages.
        prompt.restore();
        if (this.record) this.record.cursor = before;
      }
      if (sessionLost(error, connection)) this.lose();
      if (this.agent.disposed || connection.stopped) result = STOPPED;
      // Once, and only for its own message: one steered into it would be lost.
      else if (!turn.updated && !retried && turn.receipts.length === 1 && sessionLost(error, connection)) {
        this.turn = undefined;
        this.starting = item;
        turn.record.end({ outcome: "error", error: `${errorText(error)} (retrying)` });
        turn.finish({ ok: true });
        return this.runTurn(item, true);
      } else result = { ok: false, error: errorText(error) };
    } finally {
      if (this.turn === turn) this.turn = undefined;
      if (this.record) this.record.at = Date.now();
      this.save();
      this.agent.changed();
    }
    turn.record.end({ outcome: transcriptOutcome(result), error: result.error });
    turn.finish(result);
    return result;
  }

  cursorOption() {
    return this.record?.cursor ? { cursor: this.record.cursor } : undefined;
  }

  /** The model, thinking and permissions a turn runs with, as its
   * transcript shows them. */
  configLabels() {
    const named = (category) => {
      const option = optionOf(this.options, category);
      return choicesOf(option?.options).find((choice) => choice.value === option?.currentValue)?.name;
    };
    const mode = MODES.find(([id]) => id === this.mode)?.[1];
    return [named("model"), named("thought_level") && `${named("thought_level")} thinking`, mode].filter(Boolean);
  }

  // --- the Antigravity session

  /** Makes the session live for this turn: reuses it, resumes it, or starts
   * a new one, each with a fresh MCP server (a server takes one MCP
   * session, so every new or resumed Antigravity session needs its own). */
  async open(delivery, conversation, settings) {
    const agentHandle = delivery.agent;
    const connection = await this.agent.connect(agentHandle, settings);
    const cwd = await this.agent.workspace(settings);
    this.handler = this.agent.tools(agentHandle, conversation, cwd);
    const shape = sessionShape(settings);
    if (this.live && this.connection === connection && this.record?.shape === shape) {
      this.agent.opened(this); // Most recently used.
      return;
    }
    await this.close();
    // Other instructions or another workspace shape a new session.
    if (this.record?.shape !== undefined && this.record.shape !== shape) this.forget();
    await this.agent.makeRoom(this);
    // Counted from now, so opens running at once share the budget.
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
    // Buzz stops a server whose token another program used: reopen next turn.
    void mcp.closed?.then(() => {
      if (this.mcp === mcp) this.lose();
    });
    this.system = await this.agent.kit.systemPrompt(delivery, {
      scope: settings.scope,
      cwd,
      instructions: settings.instructions,
    });
    const params = sessionParams(cwd, mcp, this.system);
    let opened;
    if (this.record?.sessionId && connection.sessionCapabilities.resume)
      opened = await connection
        .request("session/resume", { sessionId: this.record.sessionId, ...params }, START_TIMEOUT_MS)
        .catch((error) => {
          // Only a session Antigravity no longer has is given up; anything
          // else (a crash, a timeout) fails this turn and keeps it for the next.
          if (connection.closed || !sessionGone(error)) throw error;
          console.warn("antigravity-acp: the saved session is gone; starting a new one", error);
          return undefined;
        });
    this.fresh = !opened;
    if (!opened) {
      if (this.record) this.forget();
      opened = await connection.request("session/new", params, START_TIMEOUT_MS);
      // A new session has been shown nothing yet.
      this.record = { sessionId: opened.sessionId, at: Date.now() };
    }
    const tier = tierOf(opened);
    if (tier) this.agent.runtime.catalog.sawTier(tier);
    this.record.shape = shape;
    this.record.whole = this.whole;
    if (this.where) this.record.where = this.where;
    this.connection = connection;
    this.options = opened.configOptions;
    this.started = {
      model: optionOf(this.options, "model")?.currentValue,
      effort: optionOf(this.options, "thought_level")?.currentValue,
    };
    this.unsubscribe = connection.onSession(this.record.sessionId, (update) => this.update(update));
    this.live = true;
    this.save();
  }

  /** Answers the session's Buzz tools with this turn's handler, recording
   * the messages its message tools post. */
  answerMcp(message) {
    if (!this.handler)
      return Promise.resolve(
        message?.id === undefined
          ? undefined
          : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "No Buzz turn is running" } },
      );
    const answer = Promise.resolve(this.handler(message));
    const call = message?.method === "tools/call" ? message.params : undefined;
    const record = this.turn?.record;
    if (!record || !MESSAGE_TOOLS.has(call?.name)) return answer;
    return answer.then((reply) => {
      const result = reply?.result;
      if (!reply?.error && !result?.isError) {
        if (this.turn) this.turn.posted = true;
        const said = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
        record.posted(call.arguments?.text, EVENT_ID.exec(said)?.[0]);
      }
      return reply;
    });
  }

  update(update) {
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      this.options = update.configOptions;
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    turn.record?.update(update);
    if (AMBIENT.has(update.sessionUpdate)) return;
    turn.updated = true;
    if (update.sessionUpdate === "session_info_update") {
      if (typeof update.title === "string" && update.title && !turn.named) {
        turn.named = true;
        for (const receipt of turn.receipts) receipt.named?.(update.title);
      }
      return;
    }
    if (turn.compacting) return;
    const step = stepOf(update);
    if (!step) return;
    const label = `${step.tool}\u0000${step.target ?? ""}`;
    if (label === turn.step) return;
    turn.step = label;
    turn.latest?.step?.(step.tool, step.target);
  }

  /** The session can't be used as it is: the next turn opens it again.
   * With `keep`, the process is left running for a close still to send. */
  lose(keep = false) {
    this.live = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const mcp = this.mcp;
    this.mcp = undefined;
    void mcp?.close().catch(() => {});
    this.agent.closed(this);
    if (!keep && !this.busy) this.agent.idle();
  }

  /** Closes the session and its MCP server, keeping the record so the next
   * turn resumes it. */
  async close() {
    clearTimeout(this.idleTimer);
    const { connection, live } = this;
    const sessionId = this.record?.sessionId;
    this.lose(true);
    if (live && sessionId && connection && !connection.closed && connection.sessionCapabilities.close)
      await connection.request("session/close", { sessionId }, CLOSE_TIMEOUT_MS).catch(() => {});
    if (!this.busy) this.agent.idle();
  }

  /** Forgets the session: the next turn starts a new one. Its transcript
   * stays. */
  forget() {
    this.record = undefined;
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
    if (item && this.turn && !this.turn.receipts.includes(item.delivery)) return;
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
    // A turn running or still opening its session ends first, so the session
    // is not closed and forgotten underneath it.
    const pending = [this.turn?.done, this.starting?.done].filter(Boolean);
    this.interrupt();
    if (pending.length)
      await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
    await this.close();
    this.forget();
    this.agent.changed();
    this.agent.idle();
  }

  /** Compacts the session's history to free context, with Antigravity's own
   * `/compact`. */
  async compact() {
    if (this.busy) throw new Error("Wait for the active turn to finish first.");
    if (!this.record) throw new Error("This conversation has no Antigravity session yet.");
    if (!this.live)
      throw new Error("This conversation's Antigravity session is closed. It opens again with the next message.");
    const turn = new Turn(undefined, { compacting: true });
    const [channelId, root] = this.key.split("/");
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId: this.record.sessionId,
      newSession: false,
      channelId,
      root,
      config: this.configLabels(),
    });
    turn.record.status("Compacting the session to free context.");
    this.turn = turn;
    this.agent.changed();
    try {
      turn.request = this.connection.request("session/prompt", {
        sessionId: this.record.sessionId,
        prompt: [{ type: "text", text: "/compact" }],
      });
      const outcome = outcomeOf((await this.settle(turn, { channel: channelId, root }))?.stopReason);
      turn.record.end({ outcome: transcriptOutcome(outcome), error: outcome.error });
      turn.finish(outcome);
    } catch (error) {
      turn.record.end({ outcome: "error", error: errorText(error) });
      turn.finish({ ok: false, error: errorText(error) });
      throw error;
    } finally {
      if (this.turn === turn) this.turn = undefined;
      this.agent.changed();
      void this.pump();
    }
  }

  /** The agent is gone: stop quietly; its process is being stopped too. */
  dispose() {
    clearTimeout(this.idleTimer);
    for (const item of this.queue.splice(0)) item.resolve(STOPPED);
    if (this.starting) this.starting.stopped = true;
    this.lose();
  }
}
