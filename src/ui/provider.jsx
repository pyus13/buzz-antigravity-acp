// Settings → Agent setup: the harness's row (its default model once ready)
// and its dialog (how Gemini is signed in, and signing in).
import { effortLabel, errorText } from "../acp/protocol.js";
import { TITLE } from "../constants.js";
import { Button, PreferenceRow, row, SettingsGroup, stack } from "./controls.jsx";
import { GeminiLogoIcon } from "./icons.jsx";
import { effortsOf, modelChoices, useCatalog, useDefaults } from "./models.jsx";
import { Fragment, h, useState } from "./react.js";
import { Select } from "./select.jsx";
import { services } from "./services.js";

/** This device's default model and thinking for agents that leave theirs
 * blank, with the way back to the dialog. */
export function DefaultControl({ onConfigure }) {
  const catalog = useCatalog();
  const defaults = useDefaults();
  const [error, setError] = useState("");
  const save = (next) =>
    services.runtime.defaults.save({ ...defaults, ...next }).then(
      () => setError(""),
      (reason) => setError(errorText(reason)),
    );
  const models = modelChoices(catalog, defaults, defaults.model, { geminiDefaultOnly: true });
  const efforts = effortsOf(catalog, defaults, defaults.model);
  const busy = catalog.loading && !catalog.models.length;
  return (
    <>
      <div style={row}>
        <Select
          label={`${TITLE} default model`}
          value={defaults.model}
          options={models.options}
          valueLabel={models.valueLabel}
          valueTitle={models.valueTitle}
          leading={<GeminiLogoIcon size={20} />}
          align="end"
          disabled={busy}
          onValueChange={(model) =>
            save({ model, effort: effortsOf(catalog, defaults, model).some((level) => level.id === defaults.effort) ? defaults.effort : "" })
          }
        />
        {efforts.length > 0 && (
          <Select
            label="Default thinking"
            value={defaults.effort}
            options={[{ value: "", label: "Automatic" }, ...efforts.map((level) => ({ value: level.id, label: effortLabel(level.id) }))]}
            valueLabel={defaults.effort ? effortLabel(defaults.effort) : "Automatic"}
            align="end"
            disabled={busy}
            onValueChange={(effort) => save({ effort })}
          />
        )}
        {onConfigure && (
          <Button size="sm" variant="ghost" onClick={onConfigure}>
            Edit configuration
          </Button>
        )}
      </div>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

export function ProviderDialogBody({ onClose }) {
  const catalog = useCatalog();
  const ready = catalog.readiness === "ready";
  const checking = catalog.readiness === "checking";
  const signingIn = Boolean(catalog.signingIn);
  const line = signingIn
    ? "Finish signing in with Google in your browser…"
    : checking
      ? "Checking Gemini…"
      : ready
        ? `Signed in with your Google account${catalog.account ? ` (${catalog.account})` : ""}.`
        : catalog.attentionDescription;
  return (
    <div style={stack("var(--space-6)")}>
      <div style={stack("var(--space-2)")}>
        <p role={catalog.readiness === "attention" && !signingIn ? "alert" : "status"} className="text-body-sm text-primary" style={{ margin: 0 }}>
          <strong>{line}</strong>
        </p>
        {signingIn && catalog.signInUrl && (
          <p className="text-body-sm text-subtle" style={{ margin: 0, overflowWrap: "anywhere" }}>
            If no browser opened, open{" "}
            <a href={catalog.signInUrl} target="_blank" rel="noreferrer">
              Google's sign-in page
            </a>
            .
          </p>
        )}
        {catalog.signInError && !signingIn && (
          <p role="alert" className="text-body-sm text-danger" style={{ margin: 0 }}>
            Couldn't sign in: {catalog.signInError}
          </p>
        )}
        <p className="text-body-sm text-subtle" style={{ margin: 0 }}>
          {TITLE} runs Gemini CLI with the Google sign-in on this computer, so a Google AI Pro or Ultra subscription is used, not
          an API key. Change accounts with /auth in gemini in a terminal.
        </p>
      </div>
      {ready && (
        <SettingsGroup>
          <PreferenceRow title="Default model" trailing={<DefaultControl />} />
        </SettingsGroup>
      )}
      <div style={{ ...row, justifyContent: "flex-end" }}>
        <Button onClick={onClose}>{ready ? "Done" : "Cancel"}</Button>
        {!ready && catalog.canSignIn && (
          <Button variant="prominent" loading={signingIn} disabled={checking} onClick={() => void services.runtime.catalog.signIn()}>
            Sign in with Google
          </Button>
        )}
        {!ready && (
          <Button variant={catalog.canSignIn ? "subtle" : "prominent"} loading={checking} disabled={signingIn} onClick={catalog.retry}>
            Check again
          </Button>
        )}
      </div>
    </div>
  );
}

export const providerOf = () => ({
  // Stable until the catalog changes: it is replaced, never changed.
  snapshot: () => services.runtime.catalog.snapshot(),
  // Buzz subscribes when it shows the row: the first read starts there,
  // never inside a snapshot.
  subscribe: (listener) => {
    const unsubscribe = services.runtime.subscribe(listener);
    void services.runtime.catalog.ensure();
    return unsubscribe;
  },
  check: () => services.runtime.catalog.check(),
  DialogBody: ProviderDialogBody,
  DefaultControl,
});
