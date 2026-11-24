// The Activity tab, laid out as Buzz's own harnesses lay theirs out: the
// conversation the profile was opened from, the agent's other recent
// conversations, and each one's transcript in Buzz's own transcript view
// (`agents.ui.Transcript`), from the turns this harness recorded.
import { Button, SettingsGroup } from "./controls.jsx";
import { h, useEffect, useId, useState, useSyncExternalStore } from "./react.js";
import { services } from "./services.js";

const RECENT_LIMIT = 20;
const styles = {
  activity: { display: "flex", flexDirection: "column", minWidth: 0, gap: "var(--space-6)" },
  section: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--space-2)", minWidth: 0, overflowWrap: "anywhere" },
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none", minWidth: 0 },
  entry: (first, last) => ({
    display: "grid",
    gap: "var(--space-2)",
    paddingBlock: "var(--space-4)",
    ...(first ? { paddingBlockStart: 0 } : {}),
    ...(last ? { paddingBlockEnd: 0 } : { borderBottom: "1px solid var(--border-standard)" }),
  }),
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)", minWidth: 0 },
  copy: { flex: "1 1 12rem", minWidth: 0, overflowWrap: "anywhere" },
  name: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};

const when = (at) =>
  at ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

/** A conversation's name: the one Buzz gave it when it ran, else its id. */
const nameOf = (row) => row.where || (row.root ? `Thread ${row.root.slice(0, 8)}` : `Channel ${row.channelId.slice(0, 8)}`);

function Header({ id, title, actions }) {
  return (
    <div data-buzz-ui="" className="buzz-content-header" data-inline="">
      <div className="buzz-content-header-copy">
        <h3 id={id} className="buzz-content-header-title">
          {title}
        </h3>
      </div>
      {actions && <div className="buzz-content-header-actions">{actions}</div>}
    </div>
  );
}

function Row({ row, detail, onView }) {
  return (
    <div style={styles.row}>
      <span style={styles.copy}>
        <span className="text-label-sm" style={styles.name} title={nameOf(row)}>
          {nameOf(row)}
        </span>
        <span className="text-body-sm text-subtle" style={{ display: "block" }}>
          {detail}
        </span>
      </span>
      <Button variant="subtle" size="sm" aria-label={`View transcript: ${nameOf(row)}`} onClick={onView}>
        View transcript
      </Button>
    </div>
  );
}

/** The conversation the profile was opened from. */
function Opened({ conversation, row, onView }) {
  const id = useId();
  const place = (row ? row.root : conversation.rootId) ? "thread" : "channel";
  return (
    <section aria-labelledby={id} style={styles.section}>
      <Header id={id} title={`This ${place}`} />
      <SettingsGroup layout="form">
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {row ? (
            <Row
              row={row}
              detail={[row.status, row.at && `Last active ${when(row.at)}`].filter(Boolean).join(" · ") || "Antigravity session"}
              onView={onView}
            />
          ) : (
            <span style={{ display: "grid", gap: "var(--space-1)" }}>
              <span className="text-label">No Antigravity session here yet</span>
              <span className="text-body-sm text-subtle">One starts when you mention the agent in this {place}.</span>
            </span>
          )}
        </div>
      </SettingsGroup>
    </section>
  );
}

function TranscriptView({ agent, row, working, onBack }) {
  const Transcript = services.agents?.ui?.Transcript;
  const id = useId();
  return (
    <section aria-labelledby={id} style={styles.section}>
      <div style={styles.row}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to profile
        </Button>
      </div>
      <Header id={id} title={nameOf(row)} />
      {Transcript ? (
        <Transcript
          agent={agent}
          readKey={`${agent.key}:${row.key}`}
          read={async () => {
            const { turns } = await services.runtime.transcript(agent.key, row.key);
            return turns.length ? { turns } : undefined;
          }}
          working={working}
          reading="Reading the transcript…"
          missing={
            <p className="text-body-sm text-subtle" style={{ margin: 0 }}>
              No turns recorded for this conversation on this device yet.
            </p>
          }
          failed="Could not read the Antigravity session"
        />
      ) : (
        <p className="text-body-sm text-subtle" style={{ margin: 0 }}>
          Transcripts need a newer Buzz.
        </p>
      )}
    </section>
  );
}

export function ActivityTab({ agent, conversation, initialTranscript }) {
  const rows = useSyncExternalStore(
    (listener) => services.runtime.subscribe(listener),
    () => services.runtime.conversationRows(agent.key),
  );
  const [open, setOpen] = useState(undefined);
  const here =
    conversation &&
    (rows.find((row) => row.channelId === conversation.channelId && row.root === conversation.rootId) ??
      rows.find((row) => row.channelId === conversation.channelId && row.whole));
  // The panel asks once to show the opened conversation's transcript first.
  useEffect(() => {
    if (!initialTranscript) return;
    if (here) setOpen(here.key);
    initialTranscript.done();
  }, [initialTranscript?.opening]);
  const shown = open && rows.find((row) => row.key === open);
  if (shown)
    return (
      <div style={styles.activity}>
        <TranscriptView agent={agent} row={shown} working={shown.status === "Working"} onBack={() => setOpen(undefined)} />
      </div>
    );
  const recent = rows
    .filter((row) => row.key !== here?.key)
    .sort((a, b) => Number(b.channelId === conversation?.channelId) - Number(a.channelId === conversation?.channelId))
    .slice(0, RECENT_LIMIT);
  return (
    <div style={styles.activity}>
      {conversation && <Opened conversation={conversation} row={here} onView={() => here && setOpen(here.key)} />}
      <section style={styles.section}>
        <Header title="Recent conversations" />
        <SettingsGroup layout="form">
          <div>
            {recent.length ? (
              <ul style={styles.list}>
                {recent.map((row, index) => (
                  <li key={row.key} style={styles.entry(index === 0, index === recent.length - 1)}>
                    <Row
                      row={row}
                      detail={[row.root ? `Thread ${row.root.slice(0, 8)}` : "Channel", row.status, when(row.at)]
                        .filter(Boolean)
                        .join(" · ")}
                      onView={() => setOpen(row.key)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body-sm text-subtle" style={{ margin: 0 }}>
                No other conversations saved in this app yet.
              </p>
            )}
          </div>
        </SettingsGroup>
      </section>
    </div>
  );
}
