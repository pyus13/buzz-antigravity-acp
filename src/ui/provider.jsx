// Settings → Agent setup: the harness's row (its default model once ready)
// and its dialog (which Google account and plan Antigravity runs on, and
// signing in or switching accounts).
import { effortLabel, errorText } from "../acp/protocol.js";
import { TITLE } from "../constants.js";
import { onFreeTier } from "../runtime/catalog.js";
import { Button, PreferenceRow, row, SettingsGroup, stack } from "./controls.jsx";
import { AntigravityLogoIcon } from "./icons.jsx";
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
  const models = modelChoices(catalog, defaults, defaults.model, { providerDefaultOnly: true });
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
          leading={<AntigravityLogoIcon size={20} />}
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
  const free = ready && onFreeTier(catalog);
  const signIn = (switching) => void services.runtime.catalog.signIn({ switching });
  const line = signingIn
    ? "Finish signing in with Google in your browser…"
    : checking
      ? "Checking Antigravity…"
      : ready
        ? `Signed in with Google${catalog.tier ? ` · ${catalog.tier.name}` : ""}.`
        : catalog.attentionDescription;
  return (
    <div style={stack("var(--space-6)")}>
      <div style={stack("var(--space-2)")}>
        <p role={catalog.readiness === "attention" && !signingIn ? "alert" : "status"} className="text-body-sm text-primary" style={{ margin: 0 }}>
          <strong>{line}</strong>
        </p>
        {free && !signingIn && (
          <p role="alert" className="text-body-sm text-warning" style={{ margin: 0 }}>
            This Google account has no Google AI Pro or Ultra plan, so agents run on Antigravity's free quota. Google Workspace
            accounts don't include one. Switch to the account with your plan.
          </p>
        )}
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
          {TITLE} runs Google's Antigravity CLI with the Google sign-in on this computer, so your Google AI Pro or Ultra plan is
          used, not an API key. The sign-in is shared with agy in a terminal.
        </p>
      </div>
      {ready && (
        <SettingsGroup>
          <PreferenceRow title="Default model" trailing={<DefaultControl />} />
        </SettingsGroup>
      )}
      <div style={{ ...row, justifyContent: "flex-end" }}>
        <Button onClick={onClose}>{ready ? "Done" : "Cancel"}</Button>
        {ready && catalog.canSwitch && (
          <Button variant={free ? "prominent" : "subtle"} loading={signingIn} onClick={() => signIn(true)}>
            Switch account
          </Button>
        )}
        {!ready && catalog.canSignIn && (
          <Button variant="prominent" loading={signingIn} disabled={checking} onClick={() => signIn(false)}>
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
