// Each agent's saved sessions: which Antigravity session each conversation
// continues, and what it has been shown.
import { SAVED_CONVERSATIONS } from "../constants.js";

const VERSION = 1;

/** A saved session: `{ sessionId, cursor?, shape?, whole?, primed?, summary?,
 * where?, at }`. `cursor` is the harness kit's opaque cursor; `shape` what
 * the session was created from; `primed` whether it has been shown Buzz's
 * system prompt; `summary` what a compaction carried over into the next
 * session; `where` the conversation's name, for the Activity tab. */
const valid = (record) => typeof record?.sessionId === "string" && record.sessionId.length > 0;

const newestFirst = (records) =>
  Object.entries(records)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, SAVED_CONVERSATIONS);

export class SessionRecords {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    /** Per agent: the save running now, and whether another is owed. */
    this.writes = new Map();
  }

  ownKey(agentKey) {
    return `${this.typeKey}/${agentKey}`;
  }

  /** The agent's saved sessions by conversation key. */
  async load(agentKey) {
    let own;
    try {
      own = JSON.parse((await this.store.read(this.ownKey(agentKey))) ?? "null");
    } catch {
      own = undefined; // Unreadable: start over rather than fail the agent.
    }
    const records = {};
    if (own?.v === VERSION && own.conversations && typeof own.conversations === "object")
      for (const [key, record] of Object.entries(own.conversations)) if (valid(record)) records[key] = record;
    return records;
  }

  /** Saves `records`. Saves for one agent run one at a time; one asked for
   * while another runs is made once after it, with the latest records. */
  save(agentKey, records) {
    let write = this.writes.get(agentKey);
    if (!write) {
      write = { running: undefined, owed: undefined };
      this.writes.set(agentKey, write);
    }
    write.owed = records;
    if (!write.running)
      write.running = (async () => {
        while (write.owed) {
          const next = write.owed;
          write.owed = undefined;
          await this.write(agentKey, next).catch((error) => console.warn("antigravity-acp: could not save sessions", error));
        }
        write.running = undefined;
      })();
    return write.running;
  }

  async write(agentKey, records) {
    const kept = newestFirst(Object.fromEntries(Object.entries(records).filter(([, record]) => valid(record))));
    await this.store.set(this.ownKey(agentKey), JSON.stringify({ v: VERSION, conversations: Object.fromEntries(kept) }));
  }

  /** Resolves once every save asked for so far has been written. */
  async flush() {
    await Promise.all([...this.writes.values()].map((write) => write.running));
  }
}
