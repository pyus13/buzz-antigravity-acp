// What Antigravity offers on this computer and whether it is signed in: the
// models with their thinking levels, the plan the Google account is on, and
// the readiness Buzz shows in Settings → Agent setup. Read with a short-lived
// Antigravity CLI process that opens one session and runs no turn. Signing in
// runs Antigravity's own Google sign-in, in the browser.
import { AcpConnection } from "../acp/connection.js";
import { choicesOf, errorText, needsSignIn, optionOf, tierOf } from "../acp/protocol.js";
import { CLOSE_TIMEOUT_MS, FREE_TIER, GOOGLE_LOGIN, SIGN_IN_TIMEOUT_MS, START_TIMEOUT_MS, TITLE } from "../constants.js";
import { DEFAULTS } from "../config.js";

const CHECKING = Object.freeze({ readiness: "checking", models: [], loading: true });
const SIGN_IN = "Sign in to Antigravity";
const SIGN_IN_HOW =
  "Sign in with the Google account that has your Google AI Pro or Ultra plan, or run agy in a terminal and sign in there, then check again.";
const AUTH_URL = /https:\/\/accounts\.google\.com\/\S+/;
const OFFERED = (level) => level.value !== "default";

export class Catalog {
  constructor(host, notify) {
    this.host = host;
    this.notify = notify;
    /** Replaced, never changed, so it can be a snapshot. */
    this.state = CHECKING;
    this.reading = undefined;
    this.signingIn = undefined;
    this.started = false;
  }

  snapshot = () => this.state;

  set(change) {
    this.state = Object.freeze({ ...this.state, ...change });
    this.notify();
  }

  /** The plan a session said the account is on, once it changes. */
  sawTier(tier) {
    if (tier.id !== this.state.tier?.id || tier.name !== this.state.tier?.name) this.set({ tier });
  }

  /** Reads the catalog the first time anyone asks for it. */
  ensure() {
    if (!this.started) void this.check();
    return this.reading ?? Promise.resolve(this.state);
  }

  /** Reads it again; one read runs at a time. */
  check() {
    this.started = true;
    if (this.reading) return this.reading;
    if (!this.state.loading) this.set({ readiness: "checking", loading: true });
    this.reading = this.read()
      .then(
        (found) => found,
        (error) => ({
          readiness: "attention",
          attentionLabel: `Set up ${TITLE}`,
          attentionDescription: errorText(error),
          error: errorText(error),
          models: [],
        }),
      )
      .then((state) => {
        this.state = Object.freeze({
          ...state,
          loading: false,
          signingIn: Boolean(this.signingIn),
          // Why the last sign-in failed, until one works.
          ...(this.state.signInError && state.readiness !== "ready" ? { signInError: this.state.signInError } : {}),
        });
        this.reading = undefined;
        this.notify();
        return this.state;
      });
    return this.reading;
  }

  /** The models, waiting for a read only when there are none yet. */
  async models() {
    const state = this.state.models.length ? this.state : await this.ensure();
    if (!state.models.length) throw new Error(state.error ?? `${TITLE} offered no models`);
    return state.models;
  }

  async read() {
    const cwd = await this.host.resolveDirectory(DEFAULTS.workspace);
    const connection = await AcpConnection.start(this.host, { cwd });
    try {
      let created;
      try {
        created = await connection.request("session/new", { cwd, mcpServers: [] }, START_TIMEOUT_MS);
      } catch (error) {
        if (connection.closed || !needsSignIn(error)) throw error;
        return {
          readiness: "attention",
          attentionLabel: SIGN_IN,
          attentionDescription: SIGN_IN_HOW,
          error: `${SIGN_IN} to choose a model.`,
          canSignIn: connection.offersGoogleLogin,
          signedOut: true,
          models: [],
        };
      }
      const models = await this.modelsOf(connection, created);
      if (connection.sessionCapabilities.close)
        await connection.request("session/close", { sessionId: created.sessionId }, CLOSE_TIMEOUT_MS).catch(() => {});
      const tier = tierOf(created);
      return {
        readiness: "ready",
        models,
        default: optionOf(created.configOptions, "model")?.currentValue,
        canSignIn: connection.offersGoogleLogin,
        canSwitch: connection.offersGoogleLogin && connection.canLogOut,
        ...(tier ? { tier } : {}),
      };
    } finally {
      void connection.stop();
    }
  }

  /** Each model with the thinking levels it takes, read by switching the
   * session to it, and the level it starts on. */
  async modelsOf(connection, created) {
    const { sessionId } = created;
    let options = created.configOptions ?? [];
    const models = [];
    for (const choice of choicesOf(optionOf(options, "model")?.options)) {
      const model = optionOf(options, "model");
      if (model?.currentValue !== choice.value) {
        const changed = await connection
          .request("session/set_config_option", { sessionId, configId: model.id, value: choice.value }, START_TIMEOUT_MS)
          .catch(() => undefined);
        if (Array.isArray(changed?.configOptions)) options = changed.configOptions;
      }
      const effort = optionOf(options, "thought_level");
      models.push({
        id: choice.value,
        label: choice.name,
        description: choice.description,
        efforts: choicesOf(effort?.options)
          .filter(OFFERED)
          .map((level) => ({ id: level.value, label: level.name })),
        ...(effort?.currentValue && effort.currentValue !== "default" ? { effort: effort.currentValue } : {}),
      });
    }
    return models;
  }

  /** Signs in with a Google account in the browser, as `agy` does, then
   * reads the catalog again. With `switching`, the signed-in account is
   * signed out first, so another one can sign in. Antigravity keeps the
   * sign-in for every later start, the terminal's included. */
  signIn({ switching = false } = {}) {
    if (this.signingIn) return this.signingIn;
    this.set({ signingIn: true, signInError: undefined, signInUrl: undefined });
    this.signingIn = (async () => {
      let connection;
      try {
        const cwd = await this.host.resolveDirectory(DEFAULTS.workspace);
        connection = await AcpConnection.start(this.host, {
          cwd,
          // The page to open, should the browser not open by itself.
          onStderr: () => {
            const url = AUTH_URL.exec(connection?.stderr ?? "")?.[0];
            if (url && url !== this.state.signInUrl) this.set({ signInUrl: url });
          },
        });
        if (!connection.offersGoogleLogin) throw new Error("This Antigravity CLI does not offer sign-in with Google.");
        if (switching && connection.canLogOut) await connection.request("logout", {}, START_TIMEOUT_MS);
        const answer = await connection.request("authenticate", { methodId: GOOGLE_LOGIN }, SIGN_IN_TIMEOUT_MS);
        const tier = tierOf(answer);
        this.set({ signInUrl: undefined, ...(tier ? { tier } : {}) });
      } catch (error) {
        this.set({ signInError: errorText(error) });
      } finally {
        void connection?.stop();
        this.signingIn = undefined;
        this.set({ signingIn: false });
      }
      return this.check();
    })();
    return this.signingIn;
  }
}

/** Whether the account's plan is Antigravity's free one: no Google AI Pro or
 * Ultra plan, as on a Google Workspace account. */
export const onFreeTier = (state) => state?.tier?.id === FREE_TIER;
