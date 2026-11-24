// One Buzz conversation (a thread, or a whole channel) and the Gemini session
// that continues it: its turns run one at a time, a message that arrives
// mid-turn waits for the next turn, and an idle session closes until needed.
import { errorText, modelsOf, modeNote, modesOf, observationsOf, stepOf } from "../acp/protocol.js";
import { geminiMode, IDLE_MS, MODES, SESSION_TIMEOUT_MS, TITLE } from "../constants.js";
import { sessionShape } from "../config.js";

export const STOPPED = Object.freeze({ ok: true, stopped: true });
/** How long a reset waits for a cancelled turn to end before closing. */
const SETTLE_MS = 5_000;
const SUMMARY_LIMIT = 40_000;
const EVENT_ID = /\b[0-9a-f]{64}\b/;
const MESSAGE_TOOLS = new Set(["send", "reply_in_subthread"]);

/** Asked of Gemini to compact a session: its answer opens the next one. */
export const COMPACT_PROMPT = `Your context is being compacted: this session ends here, and a new session continues it from your summary alone.

Write that summary now, for yourself. Include who you are working with and what they asked, the decisions made, the work done (files, commands and their results), where things stand, and every open task or promise. Be concise but leave out nothing you will need.

Do not call any tools. Answer with the summary only.`;

/** The `session/new` and `session/load` parameters for a session in `cwd`
 * whose Buzz tools `mcp` serves. */
export function sessionParams(cwd, mcp) {
  return {
    cwd,
    mcpServers: [{ type: "http", name: "buzz", url: mcp.url, headers: mcp.headers.map((header) => ({ ...header })) }],
  };
}

/** A session's model and approval mode, from its `session/new` or
 * `session/load` answer. Its first model is its default: the one a turn
 * that picks none goes back to. */
export function sessionState(answer) {
  const models = modelsOf(answer);
  const modes = modesOf(answer);
  return {
    model: models.current,
    defaultModel: models.current,
    models: models.choices.map((choice) => choice.value),
    names: Object.fromEntries(models.choices.map((choice) => [choice.value, choice.name])),
    mode: modes.current,
    modes: modes.ids,
  };
}

/** Sets a session's approval mode and model where they differ from `wanted`
 * (`{ mode: [id, synced], model: [id, synced] }`, a blank model being the
 * session's default). A value the session does not offer is left alone,
 * except a synced one, which stops the turn (NIP-AP: never replace a synced
 * setting with a default). Returns the session's state after. */
export async function applySettings(connection, sessionId, state, wanted) {
  const next = { ...state };
  const [mode, modeSynced] = wanted.mode;
  if (mode && next.mode !== mode) {
    if (next.modes.length && !next.modes.includes(mode)) {
      if (modeSynced)
        throw new Error(`This agent's synced permissions "${mode}" aren't offered by ${TITLE}. Change them in Settings.`);
    } else {
      await connection.request("session/set_mode", { sessionId, modeId: mode }, SESSION_TIMEOUT_MS);
      next.mode = mode;
    }
  }
  const [picked, modelSynced] = wanted.model;
  const model = picked || next.defaultModel;
  if (model && next.model !== model) {
    if (next.models.length && !next.models.includes(model)) {
      if (modelSynced)
        throw new Error(`This agent's synced model "${model}" isn't offered by ${TITLE}. Change it in Settings.`);
    } else {
      await connection.request("session/set_model", { sessionId, modelId: model }, SESSION_TIMEOUT_MS);
      next.model = model;
    }
  }
  return next;
}

/** What a turn runs with: a per-message pick, else the agent's own setting,
 * else this device's default, else the session's own. Only a value the
 * agent's synced settings chose counts as synced. */
export function wantedSettings(delivery, settings, defaults) {
  const synced = delivery.synced ?? {};
  const effective = defaults.effective(settings).model;
  return {
    mode: [geminiMode(settings.mode), "mode" in synced],
    model: [
      delivery.model || (effective === "default" ? "" : effective),
      !delivery.model && Boolean(settings.model) && "model" in synced,
    ],
  };
}

/** What a turn's `stopReason` means for Buzz. */
export function outcomeOf(stopReason) {
  if (stopReason === "cancelled") return STOPPED;
  if (stopReason === "refusal") return { ok: false, error: "Gemini declined to continue this turn." };
  if (stopReason === "max_tokens")
    return { ok: false, error: "Gemini's context window is full. Compact the session or start a new one." };
  if (stopReason === "max_turn_requests")
    return { ok: false, error: "Gemini stopped this turn: it detected a loop or reached its turn limit." };
  return { ok: true };
}

const transcriptOutcome = (result) => (result.stopped ? "stopped" : result.ok ? "ended" : "error");

/** Whether a failed prompt left the session unusable, so the next turn should
 * open it again. */
const sessionLost = (error, connection) =>
  Boolean(connection?.closed) || /session not found|unknown session|exited unexpectedly/i.test(errorText(error));

/** Whether `session/load` failed because Gemini no longer has the session. */
const sessionGone = (error) =>
  /not found|no previous sessions|invalid session identifier|no such file|enoent/i.test(errorText(error));

/** Updates that come with a session, not from a turn Gemini began. */
const AMBIENT = new Set(["available_commands_update", "current_mode_update", "config_option_update"]);

class Turn {
  constructor(delivery, { compacting = false } = {}) {
    this.delivery = delivery;
    this.compacting = compacting;
    /** Whether the session reported anything, so the turn began in Gemini. */
    this.updated = false;
    this.step = "";
    /** What a compaction's summary says so far. */
    this.text = "";
    /** Its transcript record. */
    this.record = undefined;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
}

export class Conversation {
  constructor(agent, key, record) {
    this.agent = agent;
    this.key = key;
    /** `{ sessionId, cursor?, shape?, whole?, primed?, summary?, compacted?,
     * where?, at }`, or undefined: no session. */
    this.record = record;
    this.connection = undefined;
    this.live = false;
    /** The session's model and approval mode. */
    this.state = undefined;
    this.mcp = undefined;
    this.handler = undefined;
    this.unsubscribe = undefined;
    /** Buzz's system prompt for the session, shown with its first turn. */
    this.system = undefined;
    /** The turn Gemini is running, or a compaction. */
    this.turn = undefined;
    /** The queued item being prepared to run, until its turn starts. */
    this.starting = undefined;
    this.queue = [];
    this.pumping = false;
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

  /** Runs a mention or wake in this conversation as its next turn. Gemini
   * CLI can't take a message into a running turn, so one that arrives while
   * Gemini works waits for the turn to end. */
  async deliver(delivery, conversation, settings) {
    this.used = Date.now();
    this.wholeNow = conversation.key === conversation.channel;
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

  async runTurn(item, retried = false) {
    const { delivery, conversation, settings } = item;
    await this.open(delivery, conversation, settings);
    if (item.stopped) return STOPPED;
    this.state = await applySettings(
      this.connection,
      this.record.sessionId,
      this.state,
      wantedSettings(delivery, settings, this.agent.defaults),
    );
    this.mode = settings.mode;
    if (item.stopped) return STOPPED;
    const before = { cursor: this.record.cursor, primed: this.record.primed, summary: this.record.summary };
    const prompt = await this.agent.kit.turnPrompt(delivery, conversation, this.cursorOption());
    if (item.stopped) {
      prompt.restore();
      return STOPPED;
    }
    // Gemini CLI takes no system prompt of its own over ACP: a session is
    // shown Buzz's with its first turn, and a compacted one's summary with it.
    const system = this.record.primed ? undefined : this.system;
    const summary = this.record.summary;
    const text = [
      system,
      summary && `<previous-session-summary>\n${summary}\n</previous-session-summary>`,
      prompt.text,
    ]
      .filter(Boolean)
      .join("\n\n");
    const turn = new Turn(delivery);
    const { connection } = this;
    const sessionId = this.record.sessionId;
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId,
      newSession: !this.record.primed,
      channelId: conversation.channel,
      root: conversation.root,
      delivery,
      system,
      prompt: summary ? `<previous-session-summary>\n${summary}\n</previous-session-summary>\n\n${prompt.text}` : prompt.text,
      config: this.configLabels(),
    });
    this.turn = turn;
    this.starting = undefined;
    this.agent.changed();
    let result;
    try {
      const sent = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      // Saved once sent: the session has been shown it.
      this.record.cursor = prompt.cursor;
      this.record.primed = true;
      delete this.record.summary;
      this.save();
      delivery.acknowledged?.();
      const answer = await sent;
      result = outcomeOf(answer?.stopReason);
      void this.agent.recordUsage({
        sessionId,
        channelId: conversation.channel,
        root: conversation.root,
        observations: observationsOf(answer, this.state?.model),
      });
    } catch (error) {
      if (!turn.updated && this.record) {
        // Gemini never began: the next prompt shows the same messages.
        prompt.restore();
        Object.assign(this.record, before);
        if (before.summary === undefined) delete this.record.summary;
      }
      if (sessionLost(error, connection)) this.lose();
      if (this.agent.disposed || connection.stopped) result = STOPPED;
      // Once: a session Gemini lost before it began is opened again.
      else if (!turn.updated && !retried && sessionLost(error, connection)) {
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

  /** The model and permissions a turn ran with, as its transcript shows them. */
  configLabels() {
    const model = this.state?.model;
    const mode = MODES.find(([, , , id]) => id === this.state?.mode)?.[1];
    return [model && (this.state?.names?.[model] ?? this.agent.modelLabel(model)), mode].filter(Boolean);
  }

  // --- the Gemini session

  /** Makes the session live for this turn: reuses it, loads it, or starts a
   * new one, each with a fresh MCP server (a server takes one MCP session, so
   * every new or loaded Gemini session needs its own). */
  async open(delivery, conversation, settings) {
    const agentHandle = delivery.agent;
    const connection = await this.agent.connect(agentHandle, settings);
    const cwd = await this.agent.workspace(settings);
    this.handler = this.agent.tools(agentHandle, conversation, cwd);
    if (typeof conversation.where === "string") this.where = conversation.where;
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
    const params = sessionParams(cwd, mcp);
    let opened;
    if (this.record?.sessionId && !this.record.compacted && connection.canLoad)
      opened = await connection
        .request("session/load", { sessionId: this.record.sessionId, ...params }, SESSION_TIMEOUT_MS)
        .catch((error) => {
          // Only a session Gemini no longer has is given up; anything else
          // (a crash, a timeout) fails this turn and keeps it for the next.
          if (connection.closed || !sessionGone(error)) throw error;
          console.warn("gemini-acp: the saved session is gone; starting a new one", error);
          return undefined;
        });
    if (opened) {
      // Saved before this harness kept the mark: it was shown its first turn.
      if (this.record.primed === undefined) this.record.primed = true;
    } else {
      // A compacted session carries on from what it was shown and its summary.
      const carried = this.record?.compacted
        ? { ...(this.record.cursor ? { cursor: this.record.cursor } : {}), summary: this.record.summary }
        : {};
      if (this.record) this.forget();
      opened = await connection.request("session/new", params, SESSION_TIMEOUT_MS);
      this.record = { sessionId: opened.sessionId, at: Date.now(), primed: false, ...carried };
    }
    this.record.shape = shape;
    this.record.whole = this.whole;
    if (this.where) this.record.where = this.where;
    this.connection = connection;
    this.state = sessionState(opened);
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
        const said = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
        record.posted(call.arguments?.text, EVENT_ID.exec(said)?.[0]);
      }
      return reply;
    });
  }

  update(update) {
    const turn = this.turn;
    if (!turn || AMBIENT.has(update?.sessionUpdate)) return;
    turn.updated = true;
    turn.record?.update(update);
    if (turn.compacting) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && !modeNote(update)) {
        if (update._meta?.reset) turn.text = "";
        turn.text += update.content.text;
      }
      return;
    }
    const step = stepOf(update);
    if (!step) return;
    const label = `${step.tool}\u0000${step.target ?? ""}`;
    if (label === turn.step) return;
    turn.step = label;
    turn.delivery?.step?.(step.tool, step.target);
  }

  /** The session can't be used as it is: the next turn opens it again. */
  lose() {
    this.live = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const mcp = this.mcp;
    this.mcp = undefined;
    void mcp?.close().catch(() => {});
    this.agent.closed(this);
    if (!this.busy) this.agent.idle();
  }

  /** Closes the session's MCP server, keeping the record so the next turn
   * loads the session again. Gemini CLI has no way to close one session; it
   * is let go of, and goes with its process once the agent is idle. */
  async close() {
    clearTimeout(this.idleTimer);
    this.lose();
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
    if (item && this.turn && this.turn.delivery !== item.delivery) return;
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
    // is not forgotten underneath it.
    const pending = [this.turn?.done, this.starting?.done].filter(Boolean);
    this.interrupt();
    if (pending.length)
      await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
    await this.close();
    this.forget();
    this.agent.changed();
    this.agent.idle();
  }

  /** Compacts the session: Gemini CLI has no compaction a client can ask
   * for, so Gemini summarizes the session, and the next message starts a new
   * session from that summary, shown no message twice. */
  async compact() {
    if (this.busy) throw new Error("Wait for the active turn to finish first.");
    if (!this.record) throw new Error("This conversation has no Gemini session yet.");
    if (!this.live)
      throw new Error("This conversation's Gemini session is closed. It opens again with the next message.");
    const turn = new Turn(undefined, { compacting: true });
    const { connection } = this;
    const { sessionId } = this.record;
    const [channelId, root] = this.key.split("/");
    turn.record = await this.agent.transcripts.begin(this.agent.key, this.key, {
      sessionId,
      newSession: false,
      channelId,
      root,
      config: this.configLabels(),
    });
    turn.record.status("Compacting: Gemini summarizes this session, and the next message starts a new one from the summary.");
    this.turn = turn;
    // The session's Buzz tools post nothing while it summarizes.
    this.handler = undefined;
    this.agent.changed();
    try {
      const answer = await connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: COMPACT_PROMPT }],
      });
      const outcome = outcomeOf(answer?.stopReason);
      void this.agent.recordUsage({ sessionId, channelId, root, observations: observationsOf(answer, this.state?.model) });
      if (outcome.stopped || !outcome.ok) {
        turn.record.end({ outcome: transcriptOutcome(outcome), error: outcome.error });
        turn.finish(outcome);
        if (outcome.error) throw new Error(outcome.error);
        return;
      }
      const summary = turn.text.trim();
      if (!summary) throw new Error("Gemini returned no summary, so the session was kept.");
      await this.close();
      this.record = {
        ...this.record,
        compacted: true,
        primed: false,
        summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary,
        at: Date.now(),
      };
      this.save();
      turn.record.end({ outcome: "ended" });
      turn.finish({ ok: true });
    } catch (error) {
      turn.record.end({ outcome: "error", error: errorText(error) });
      turn.finish({ ok: false, error: errorText(error) });
      throw error;
    } finally {
      if (this.turn === turn) this.turn = undefined;
      this.agent.changed();
      void this.pump();
      this.agent.idle();
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
