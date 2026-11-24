// Each agent's token use, by Antigravity session, as Buzz's usage views read it
// (`AgentType.usage`). Antigravity reports a turn's tokens when the turn ends;
// they are kept on this device as they come.
import { USAGE_OBSERVATIONS, USAGE_SESSIONS } from "../constants.js";

const VERSION = 1;

export class UsageBook {
  constructor(store, typeKey) {
    this.store = store;
    this.typeKey = typeKey;
    /** Per agent: its sessions by id, once read. */
    this.held = new Map();
    this.writes = new Map();
  }

  key(agentKey) {
    return `${this.typeKey}.usage.v${VERSION}:${agentKey}`;
  }

  async load(agentKey) {
    let held = this.held.get(agentKey);
    if (held) return held;
    let sessions = {};
    try {
      const saved = JSON.parse((await this.store.read(this.key(agentKey))) ?? "null");
      if (saved?.v === VERSION && saved.sessions && typeof saved.sessions === "object") sessions = saved.sessions;
    } catch {
      // Unreadable: no usage.
    }
    held = this.held.get(agentKey) ?? sessions;
    this.held.set(agentKey, held);
    return held;
  }

  /** Adds a turn's `observations` to session `sessionId`, where it started. */
  async add(agentKey, { sessionId, channelId, root, wake, observations }) {
    if (!sessionId || !observations?.length) return;
    const sessions = await this.load(agentKey);
    const now = Date.now();
    const prior = sessions[sessionId];
    sessions[sessionId] = {
      ...(prior ?? { startedAt: observations[0].at ?? now }),
      ...(channelId && !prior?.channelId ? { channelId } : {}),
      ...(root && !prior?.root ? { root } : {}),
      ...(wake && !prior?.wake ? { wake } : {}),
      lastAt: now,
      observations: [...(prior?.observations ?? []), ...observations].slice(-USAGE_OBSERVATIONS),
    };
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
      .slice(0, USAGE_SESSIONS);
    const next = Object.fromEntries(kept);
    this.held.set(agentKey, next);
    await this.save(agentKey);
  }

  save(agentKey) {
    const prior = this.writes.get(agentKey) ?? Promise.resolve();
    const write = prior
      .then(() => this.store.set(this.key(agentKey), JSON.stringify({ v: VERSION, sessions: this.held.get(agentKey) ?? {} })))
      .catch((error) => console.warn("antigravity-acp: could not save usage", error));
    this.writes.set(agentKey, write);
    return write;
  }

  /** The agent's sessions with activity since `since`, as Buzz reads usage. */
  async read(agentKey, { since = 0, signal } = {}) {
    signal?.throwIfAborted?.();
    const sessions = await this.load(agentKey);
    signal?.throwIfAborted?.();
    return Object.entries(sessions)
      .filter(([, session]) => (session.lastAt ?? 0) >= since)
      .map(([id, session]) => ({
        id,
        revision: `${session.observations.length}:${session.lastAt}`,
        gaps: [],
        ...(session.channelId ? { channelId: session.channelId } : {}),
        ...(session.root ? { root: session.root } : {}),
        ...(session.wake ? { wake: session.wake } : {}),
        startedAt: session.startedAt,
        lastAt: session.lastAt,
        observations: session.observations,
      }));
  }
}
