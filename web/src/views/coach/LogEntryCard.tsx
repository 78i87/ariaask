import { useState } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useSnackbar } from "../../components/Snackbar";
import { useJourney } from "./journeyContext";
import { useMessageInfo } from "./coachActions";
import "./LogEntryCard.css";

export interface LogSpec {
  topic: string;
  goal: string;
  strategy: string;
  resultGap: string;
  nextMove: string;
}

export function parseLog(source: string): LogSpec | null {
  try {
    const l = JSON.parse(source) as Partial<LogSpec>;
    if (typeof l.topic !== "string" || !l.topic.trim()) return null;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      topic: l.topic.trim(),
      goal: str(l.goal),
      strategy: str(l.strategy),
      resultGap: str(l.resultGap),
      nextMove: str(l.nextMove),
    };
  } catch {
    return null;
  }
}

const FIELD_ROWS: { key: keyof LogSpec; label: string }[] = [
  { key: "goal", label: "Goal" },
  { key: "strategy", label: "How" },
  { key: "resultGap", label: "Result" },
  { key: "nextMove", label: "Next" },
];

/**
 * The coach-drafted learning-log entry as an editable confirm card (```log
 * fenced blocks). Unlike choices, it stays live in ANY coach message — the
 * user usually answers the reply's retrieval question before confirming — and
 * that's safe because the entry id ("log:<messageId>") makes confirms
 * idempotent server-side. Logged state is derived from the shared journey
 * entries, so it survives reloads.
 */
export function LogEntryCard({ spec }: { spec: LogSpec }) {
  const { entries, addEntry } = useJourney();
  const { messageId } = useMessageInfo();
  const snackbar = useSnackbar();
  const [draft, setDraft] = useState<LogSpec>(spec);
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const entryId = messageId ? `log:${messageId}` : undefined;
  const logged = entryId !== undefined && entries.some((e) => e.id === entryId);

  if (logged) {
    const entry = entries.find((e) => e.id === entryId);
    return (
      <div className="logcard logcard--done">
        <Icon name="check" size={18} />
        <span className="body-medium">
          Logged to your journey — <strong>{entry?.topic ?? draft.topic}</strong>
        </span>
      </div>
    );
  }
  if (skipped) {
    return (
      <div className="logcard logcard--done logcard--skipped">
        <span className="body-medium">Not logged.</span>
        <button type="button" className="logcard__undo label-medium" onClick={() => setSkipped(false)}>
          Undo
        </button>
      </div>
    );
  }

  const confirm = async () => {
    if (!entryId || !draft.topic.trim() || saving) return;
    setSaving(true);
    try {
      await addEntry({ id: entryId, ...draft, topic: draft.topic.trim(), source: "coach" });
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't save the entry");
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof LogSpec) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="logcard">
      <div className="logcard__head">
        <Icon name="timeline" size={18} />
        <span className="label-large">Log this session?</span>
      </div>
      <div className="logcard__row">
        <span className="logcard__eyebrow label-medium">Topic</span>
        <input className="logcard__input logcard__input--topic body-medium" value={draft.topic} onChange={set("topic")} />
      </div>
      {FIELD_ROWS.map(({ key, label }) => (
        <div key={key} className="logcard__row">
          <span className="logcard__eyebrow label-medium">{label}</span>
          <input className="logcard__input body-medium" value={draft[key]} onChange={set(key)} />
        </div>
      ))}
      <div className="logcard__actions">
        <Button variant="text" onClick={() => setSkipped(true)} disabled={saving}>
          Skip
        </Button>
        <Button icon="check" onClick={() => void confirm()} disabled={!entryId || !draft.topic.trim() || saving}>
          {saving ? "Saving…" : "Add to journey"}
        </Button>
      </div>
    </div>
  );
}
