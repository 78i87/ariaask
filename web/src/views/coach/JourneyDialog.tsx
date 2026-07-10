import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { TextField } from "../../components/TextField";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import type { LearningLogEntry } from "../../lib/types";
import { useJourney } from "./journeyContext";
import "./JourneyDialog.css";

interface JourneyDialogProps {
  open: boolean;
  notebookId: string;
  onClose: () => void;
  /** Start a spaced return on this topic in the coach chat. */
  onQuickReturn: (topic: string) => void;
  /** Start working on a plan task in the coach chat. */
  onStartTask: (position: number, title: string) => void;
  /** Ask the coach to draft a study plan in the chat. */
  onRequestPlan: () => void;
}

interface EntryDraft {
  topic: string;
  goal: string;
  strategy: string;
  resultGap: string;
  nextMove: string;
}

const EMPTY_DRAFT: EntryDraft = { topic: "", goal: "", strategy: "", resultGap: "", nextMove: "" };

const norm = (topic: string) => topic.trim().toLowerCase().replace(/\s+/g, " ");

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The five log fields, shared by inline edit and manual add. */
function EntryFields({ value, onChange }: { value: EntryDraft; onChange: (v: EntryDraft) => void }) {
  const set = (k: keyof EntryDraft) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="jrn__form">
      <TextField label="Topic" value={value.topic} onChange={set("topic")} autoFocus />
      <TextField label="Goal" value={value.goal} onChange={set("goal")} />
      <TextField label="Strategy" value={value.strategy} onChange={set("strategy")} supportingText="The study method you used — not thinking moves" />
      <TextField label="Result / gap" value={value.resultGap} onChange={set("resultGap")} />
      <TextField label="Next move" value={value.nextMove} onChange={set("nextMove")} />
    </div>
  );
}

const FIELD_ROWS: { key: keyof EntryDraft; label: string }[] = [
  { key: "goal", label: "Goal" },
  { key: "strategy", label: "How" },
  { key: "resultGap", label: "Result" },
  { key: "nextMove", label: "Next" },
];

/**
 * The project's journey: the learning log grouped by day with topic chips
 * (the "folders" of a project), due-return chips on top, inline edit, and a
 * deliberately buried manual add form — the coach normally drafts entries.
 */
export function JourneyDialog({ open, notebookId, onClose, onQuickReturn, onStartTask, onRequestPlan }: JourneyDialogProps) {
  const { entries, due, plan, refresh, setTaskStatus } = useJourney();
  const snackbar = useSnackbar();
  const [filter, setFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LearningLogEntry | null>(null);
  const [planDeleteOpen, setPlanDeleteOpen] = useState(false);

  const nextTaskIdx = plan?.tasks.findIndex((t) => t.status === "pending") ?? -1;
  const doneCount = plan?.tasks.filter((t) => t.status === "done").length ?? 0;

  const toggleTask = (taskId: string, done: boolean) => {
    void setTaskStatus(taskId, done ? "done" : "pending").catch((err) =>
      snackbar.show(err instanceof Error ? err.message : "Couldn't update the task"),
    );
  };

  const confirmPlanDelete = async () => {
    setPlanDeleteOpen(false);
    try {
      await api.deletePlan(notebookId);
      refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't delete the plan");
    }
  };

  const sorted = useMemo(() => [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [entries]);
  const topics = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const e of sorted) {
      const key = norm(e.topic);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(e.topic);
    }
    return list;
  }, [sorted]);
  const shown = filter ? sorted.filter((e) => norm(e.topic) === norm(filter)) : sorted;

  const groups = useMemo(() => {
    const out: { label: string; items: LearningLogEntry[] }[] = [];
    for (const e of shown) {
      const label = dayLabel(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [shown]);

  const startEdit = (e: LearningLogEntry) => {
    setAdding(false);
    setEditingId(e.id);
    setDraft({ topic: e.topic, goal: e.goal, strategy: e.strategy, resultGap: e.resultGap, nextMove: e.nextMove });
  };

  const saveEdit = async () => {
    if (!editingId || !draft.topic.trim()) return;
    try {
      await api.updateLogEntry(notebookId, editingId, draft);
      setEditingId(null);
      refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't save the entry");
    }
  };

  const saveNew = async () => {
    if (!draft.topic.trim()) return;
    try {
      await api.addLogEntry(notebookId, { ...draft, source: "user" });
      setAdding(false);
      setDraft(EMPTY_DRAFT);
      refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't add the entry");
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await api.deleteLogEntry(notebookId, target.id);
      refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't delete the entry");
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        icon="timeline"
        headline="Journey"
        actions={
          <Button variant="text" onClick={onClose}>
            Close
          </Button>
        }
      >
        {plan && plan.tasks.length > 0 ? (
          <section className="jrn__plan">
            <div className="jrn__plan-head">
              <span className="jrn__section-label label-medium">
                Study plan · {doneCount} of {plan.tasks.length} done
              </span>
              <div className="jrn__plan-bar" role="progressbar" aria-valuemin={0} aria-valuemax={plan.tasks.length} aria-valuenow={doneCount}>
                <div className="jrn__plan-fill" style={{ width: `${(doneCount / plan.tasks.length) * 100}%` }} />
              </div>
              <IconButton icon="delete" ariaLabel="Delete plan" onClick={() => setPlanDeleteOpen(true)} />
            </div>
            {plan.tasks.map((t, i) => (
              <div key={t.id} className={`jrn__task${t.status === "done" ? " jrn__task--done" : ""}${i === nextTaskIdx ? " jrn__task--next" : ""}`}>
                <button
                  type="button"
                  className="jrn__task-check"
                  aria-label={t.status === "done" ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
                  onClick={() => toggleTask(t.id, t.status !== "done")}
                >
                  {t.status === "done" && <Icon name="check" size={14} />}
                </button>
                <div className="jrn__task-body">
                  <span className="jrn__task-title body-medium">
                    {i + 1}. {t.title}
                  </span>
                  {t.detail && <span className="jrn__task-detail body-medium">{t.detail}</span>}
                </div>
                {i === nextTaskIdx && (
                  <Button variant="text" onClick={() => onStartTask(i + 1, t.title)}>
                    Start
                  </Button>
                )}
              </div>
            ))}
          </section>
        ) : (
          <div className="jrn__plan-hint">
            <Button variant="text" icon="checklist" onClick={onRequestPlan}>
              Ask your coach for a study plan
            </Button>
          </div>
        )}

        {due.length > 0 && (
          <div className="jrn__due">
            <span className="jrn__section-label label-medium">Worth a quick return</span>
            <div className="jrn__chips">
              {due.map((d) => (
                <Chip
                  key={norm(d.topic)}
                  icon="history_edu"
                  label={`${d.topic} · ${d.daysSince}d`}
                  onClick={() => onQuickReturn(d.topic)}
                />
              ))}
            </div>
          </div>
        )}

        {topics.length > 1 && (
          <div className="jrn__chips jrn__topics">
            {topics.map((t) => (
              <Chip
                key={norm(t)}
                label={t}
                selected={filter !== null && norm(filter) === norm(t)}
                onClick={() => setFilter(filter !== null && norm(filter) === norm(t) ? null : t)}
              />
            ))}
          </div>
        )}

        {entries.length === 0 && !adding && (
          <p className="jrn__empty body-medium">
            No log entries yet. At the end of a study session your coach drafts one — topic, goal,
            strategy, result, next move — and you just confirm it.
          </p>
        )}

        {groups.map((g) => (
          <section key={g.label} className="jrn__day">
            <span className="jrn__section-label label-medium">{g.label}</span>
            {g.items.map((e) =>
              editingId === e.id ? (
                <div key={e.id} className="jrn__entry jrn__entry--editing">
                  <EntryFields value={draft} onChange={setDraft} />
                  <div className="jrn__form-actions">
                    <Button variant="text" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button onClick={() => void saveEdit()} disabled={!draft.topic.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={e.id} className="jrn__entry">
                  <div className="jrn__entry-head">
                    <span className="jrn__topic label-medium">{e.topic}</span>
                    <span className="jrn__time label-medium">
                      {new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="jrn__entry-actions">
                      <IconButton icon="edit" ariaLabel="Edit entry" onClick={() => startEdit(e)} />
                      <IconButton icon="delete" ariaLabel="Delete entry" onClick={() => setDeleteTarget(e)} />
                    </span>
                  </div>
                  {FIELD_ROWS.filter(({ key }) => e[key]).map(({ key, label }) => (
                    <div key={key} className="jrn__row">
                      <span className="jrn__eyebrow label-medium">{label}</span>
                      <span className="jrn__text body-medium">{e[key]}</span>
                    </div>
                  ))}
                </div>
              ),
            )}
          </section>
        ))}

        {adding ? (
          <div className="jrn__entry jrn__entry--editing">
            <EntryFields value={draft} onChange={setDraft} />
            <div className="jrn__form-actions">
              <Button variant="text" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button onClick={() => void saveNew()} disabled={!draft.topic.trim()}>
                Add entry
              </Button>
            </div>
          </div>
        ) : (
          <div className="jrn__add">
            <Button
              variant="text"
              icon="add"
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_DRAFT);
                setAdding(true);
              }}
            >
              Add entry manually
            </Button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={planDeleteOpen}
        onClose={() => setPlanDeleteOpen(false)}
        icon="delete"
        headline="Delete the study plan?"
        actions={
          <>
            <Button variant="text" onClick={() => setPlanDeleteOpen(false)}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmPlanDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <span className="body-medium">
          All {plan?.tasks.length ?? 0} tasks go with it ({doneCount} done). Your log entries stay.
        </span>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        icon="delete"
        headline="Delete this log entry?"
        actions={
          <>
            <Button variant="text" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <span className="body-medium">
          The <strong>{deleteTarget?.topic}</strong> entry from {deleteTarget ? dayLabel(deleteTarget.createdAt).toLowerCase() : ""} will be
          removed — its topic's return schedule rewinds accordingly.
        </span>
      </Dialog>
    </>
  );
}
