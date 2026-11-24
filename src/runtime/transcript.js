// Each conversation's transcript, as Buzz's own transcript view shows it
// (`agents.ui.Transcript`): the turns this harness ran, recorded from what
// Gemini reported while they ran, and kept on this device.
//
// Gemini CLI's ACP mode has no way to read a session's history without
// opening it again, so the transcript is kept as it happens instead.
import { buzzToolOf, modeNote, promptSections, toolNameOf } from "../acp/protocol.js";
import { TRANSCRIPT_TURNS } from "../constants.js";

const VERSION = 1;
const TEXT_LIMIT = 20_000;
const OUTPUT_LIMIT = 4_000;
const ITEM_LIMIT = 400;
/** How long after a change a running turn is saved. */
const SAVE_MS = 2_000;
const EVENT_ID = /^[0-9a-f]{64}$/;

const clip = (text, limit = TEXT_LIMIT) =>
  typeof text !== "string" ? "" : text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The text of ACP tool call content, and its file diffs. */
function contentOf(content) {
  const texts = [];
  const diffs = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "content" && part.content?.type === "text") texts.push(part.content.text);
    if (part?.type === "diff" && typeof part.path === "string")
      diffs.push({
        path: part.path,
        ...(typeof part.oldText === "string" && part.oldText ? { oldText: clip(part.oldText) } : {}),
        newText: clip(part.newText ?? ""),
      });
  }
  return { text: texts.join("\n"), diffs };
}

/** What started a turn, as the person said it, and who said it. */
function askedBy(delivery, promptText) {
  const trigger = delivery?.trigger ?? {};
  const event = trigger.event;
  if (typeof event?.content === "string")
    return { text: event.content, ...(typeof event.pubkey === "string" ? { authorPubkey: event.pubkey } : {}) };
  if (typeof trigger.text === "string") return { text: trigger.text };
  const section = promptSections(promptText).find((item) => item.tag === "buzz-event" || item.tag === "text");
  return { text: clip(section?.body ?? "", 2_000) };
}

/** The ids of the Buzz events a turn answers. */
function eventsOf(delivery) {
  const trigger = delivery?.trigger ?? {};
  const ids = [trigger.event?.id, ...(Array.isArray(trigger.events) ? trigger.events.map((item) => item?.event?.id ?? item?.id) : [])];
  return ids.filter((id) => typeof id === "string" && EVENT_ID.test(id));
}

export class TranscriptStore {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    /** Transcripts read or written this run, by agent and conversation. */
    this.held = new Map();
    this.timers = new Map();
  }

  key(agentKey, conversationKey) {
    return `${this.typeKey}.transcript.v${VERSION}:${agentKey}:${conversationKey}`;
  }

  /** A conversation's turns, oldest first. */
  async read(agentKey, conversationKey) {
    const key = this.key(agentKey, conversationKey);
    let held = this.held.get(key);
    if (!held) {
      let turns = [];
      try {
        const saved = JSON.parse((await this.store.read(key)) ?? "null");
        if (saved?.v === VERSION && Array.isArray(saved.turns)) turns = saved.turns;
      } catch {
        // Unreadable: no transcript.
      }
      // Another read may have filled it meanwhile.
      held = this.held.get(key) ?? { turns };
      this.held.set(key, held);
    }
    return held;
  }

  /** Starts recording a turn. Returns its recorder. */
  async begin(agentKey, conversationKey, details) {
    await this.read(agentKey, conversationKey);
    const key = this.key(agentKey, conversationKey);
    const turn = new TurnRecord(details, (value) => this.changed(key, value));
    const held = this.held.get(key);
    this.held.set(key, { turns: [...held.turns, turn.value].slice(-TRANSCRIPT_TURNS) });
    this.changed(key, turn.value);
    return turn;
  }

  /** A turn's new `value`: it replaces the one held, and is saved soon. */
  changed(key, value) {
    const held = this.held.get(key);
    if (held)
      this.held.set(key, { turns: held.turns.map((turn) => (turn.turnId === value.turnId ? value : turn)) });
    // Buzz's transcript view reads again on the agent's steps and on a timer.
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.save(key);
      }, SAVE_MS),
    );
  }

  async save(key) {
    const held = this.held.get(key);
    if (!held) return;
    await this.store
      .set(key, JSON.stringify({ v: VERSION, turns: held.turns }))
      .catch((error) => console.warn("gemini-acp: could not save a transcript", error));
  }

  /** Forgets a conversation's transcript. */
  async forget(agentKey, conversationKey) {
    const key = this.key(agentKey, conversationKey);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.held.delete(key);
    await this.store.set(key, null).catch(() => {});
  }

  /** Saves every transcript with a change still waiting. */
  async flush() {
    const keys = [...this.timers.keys()];
    for (const key of keys) clearTimeout(this.timers.get(key));
    this.timers.clear();
    await Promise.all(keys.map((key) => this.save(key)));
  }
}

/** One turn as it is recorded. Its `value` is the transcript's turn,
 * replaced on each change so a view sees a new object. */
export class TurnRecord {
  constructor({ sessionId, newSession, channelId, root, delivery, system, prompt, config = [] }, changed) {
    const at = Date.now();
    this.changed = changed;
    this.next = 0;
    this.tools = new Map();
    this.open = undefined;
    this.value = {
      turnId: `${sessionId}:${at}:${Math.random().toString(36).slice(2, 8)}`,
      channelId: channelId ?? null,
      threadRootId: root ?? null,
      triggeringEventIds: eventsOf(delivery),
      sessionId,
      newSession: Boolean(newSession),
      config,
      startedAt: at,
      partial: false,
      items: [],
    };
    if (system) this.add({ type: "system", sections: promptSections(system) });
    if (prompt !== undefined)
      this.add({ type: "prompt", ...askedBy(delivery, prompt), sections: promptSections(prompt), steer: false });
  }

  add(item) {
    if (this.value.items.length >= ITEM_LIMIT) return undefined;
    const full = { id: `i${++this.next}`, at: Date.now(), ...item };
    this.value = { ...this.value, items: [...this.value.items, full] };
    this.open = undefined;
    this.changed(this.value);
    return full.id;
  }

  replace(id, change) {
    const items = this.value.items.map((item) => (item.id === id ? { ...item, ...change(item) } : item));
    this.value = { ...this.value, items };
    this.changed(this.value);
  }

  /** A `session/update` of this turn. */
  update(update) {
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = update.content?.type === "text" ? update.content.text : "";
        if (!text || modeNote(update)) return;
        const type = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
        // A retried response starts its text over.
        if (update._meta?.reset && this.open?.type === type) this.replace(this.open.id, () => ({ text: "" }));
        if (this.open?.type === type) {
          const { id } = this.open;
          this.replace(id, (item) => ({ text: clip(item.text + text) }));
          this.open = { id, type };
        } else {
          const id = this.add({ type, text: clip(text) });
          if (id) this.open = { id, type };
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        // Buzz's message tools show as the messages they post (`posted`).
        if (buzzToolMessage(update)) return;
        const { text, diffs } = contentOf(update.content);
        const paths = Array.isArray(update.locations)
          ? update.locations.map((location) => location?.path).filter((path) => typeof path === "string")
          : undefined;
        const status = typeof update.status === "string" ? update.status : undefined;
        const ended = status === "completed" || status === "failed";
        const known = this.tools.get(callId);
        if (!known) {
          const name = toolNameOf(update);
          const id = this.add({
            type: "tool",
            toolCallId: callId,
            title: clip(typeof update.title === "string" && update.title ? update.title : (name ?? "Tool"), 400),
            kind: typeof update.kind === "string" ? update.kind : "other",
            status: status ?? "in_progress",
            input: name && buzzToolOf(name) ? `buzz ${buzzToolOf(name)}` : (name ?? ""),
            output: clip(text, OUTPUT_LIMIT),
            diffs,
            paths: paths ?? [],
            ...(ended ? { completedAt: Date.now() } : {}),
            truncated: false,
          });
          if (id) this.tools.set(callId, id);
          return;
        }
        this.replace(known, (item) => ({
          ...(status ? { status } : {}),
          ...(typeof update.title === "string" && update.title ? { title: clip(update.title, 400) } : {}),
          ...(text ? { output: clip(text, OUTPUT_LIMIT) } : {}),
          ...(diffs.length ? { diffs } : {}),
          ...(paths?.length ? { paths } : {}),
          ...(ended && !item.completedAt ? { completedAt: Date.now() } : {}),
        }));
        this.open = undefined;
        return;
      }
      case "plan": {
        const entries = (Array.isArray(update.entries) ? update.entries : [])
          .filter((entry) => typeof entry?.content === "string")
          .map((entry) => ({ content: clip(entry.content, 2_000), status: String(entry.status ?? "pending") }));
        if (entries.length) this.add({ type: "plan", entries });
        return;
      }
      case "usage_update":
        if (typeof update.used === "number" && typeof update.size === "number") {
          this.value = { ...this.value, context: { used: update.used, size: update.size } };
          this.changed(this.value);
        }
        return;
      default:
    }
  }

  /** A message the agent posted to Buzz with one of its message tools. */
  posted(text, messageId) {
    if (typeof text !== "string" || !text) return;
    this.add({ type: "message", text: clip(text), posted: true, ...(messageId ? { messageId } : {}) });
  }

  status(text) {
    this.add({ type: "status", text });
  }

  /** The turn ended: `outcome` is `ended`, `stopped` or `error`. */
  end({ outcome, error, stopReason }) {
    if (this.value.endedAt) return;
    this.value = {
      ...this.value,
      endedAt: Date.now(),
      outcome,
      ...(error ? { error: clip(error, 2_000) } : {}),
      ...(stopReason ? { stopReason } : {}),
      // Tools still running when the turn ended did not finish.
      items: this.value.items.map((item) =>
        item.type === "tool" && (item.status === "in_progress" || item.status === "pending")
          ? { ...item, status: outcome === "stopped" ? "cancelled" : "failed" }
          : item,
      ),
    };
    this.changed(this.value);
  }
}

/** Whether an update is about one of Buzz's message tools. */
function buzzToolMessage(update) {
  const tool = buzzToolOf(toolNameOf(update));
  return tool === "send" || tool === "reply_in_subthread";
}
