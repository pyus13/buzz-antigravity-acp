// What Gemini offers on this computer and whether it is signed in: the models,
// the Google account, and the readiness Buzz shows in Settings → Agent setup.
// Read with a short-lived Gemini CLI process that opens one session and runs
// no turn. Signing in runs Gemini CLI's own Google sign-in, in the browser.
import { AcpConnection } from "../acp/connection.js";
import { errorText, modelsOf, needsSignIn } from "../acp/protocol.js";
import { GOOGLE_LOGIN, SESSION_TIMEOUT_MS, SIGN_IN_TIMEOUT_MS, TITLE } from "../constants.js";
import { DEFAULTS } from "../config.js";

const CHECKING = Object.freeze({ readiness: "checking", models: [], loading: true });
const SIGN_IN = "Sign in to Gemini";
const SIGN_IN_HOW =
  "Sign in with the Google account of your Gemini subscription, or run gemini in a terminal and choose Sign in with Google, then check again.";
/** Where Gemini CLI keeps the signed-in account (`google_accounts.json`). */
const ACCOUNTS = "~/.gemini";
const AUTH_URL = /https:\/\/accounts\.google\.com\/\S+/;

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
        this.state = Object.freeze({ ...state, loading: false, signingIn: Boolean(this.signingIn) });
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
        created = await connection.request("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
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
      const models = modelsOf(created).choices.map((choice) => ({
        id: choice.value,
        label: choice.name,
        description: choice.description,
        // Gemini CLI's ACP mode lets a client pick no thinking level: each
        // model thinks as Gemini sets it up.
        efforts: [],
      }));
      return { readiness: "ready", account: await this.account(), models, default: modelsOf(created).current };
    } finally {
      void connection.stop();
    }
  }

  /** The signed-in Google account, as Gemini CLI saved it, if it says. */
  async account() {
    try {
      const folder = await this.host.resolveDirectory(ACCOUNTS);
      const bytes = await this.host.readFile("google_accounts.json", { cwd: folder });
      const active = JSON.parse(new TextDecoder().decode(bytes))?.active;
      return typeof active === "string" && active ? active : undefined;
    } catch {
      return undefined;
    }
  }

  /** Signs in with a Google account in the browser, as `gemini` does, then
   * reads the catalog again. Gemini CLI saves the sign-in for every later
   * start, the terminal's included. */
  signIn() {
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
        if (!connection.offersGoogleLogin) throw new Error(`This Gemini CLI does not offer sign-in with Google.`);
        await connection.request("authenticate", { methodId: GOOGLE_LOGIN }, SIGN_IN_TIMEOUT_MS);
        this.set({ signInUrl: undefined });
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
