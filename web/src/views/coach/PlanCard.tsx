import { useState } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useSnackbar } from "../../components/Snackbar";
import { useJourney } from "./journeyContext";
import { useMessageInfo } from "./coachActions";
import "./PlanCard.css";

export interface PlanSpec {
  tasks: { title: string; detail: string; topic?: string }[];
}

export function parsePlan(source: string): PlanSpec | null {
  try {
    const p = JSON.parse(source) as { tasks?: unknown };
    if (!Array.isArray(p.tasks)) return null;
    const tasks = p.tasks
      .map((raw) => {
        const t = (raw ?? {}) as Record<string, unknown>;
        if (typeof t.title !== "string" || !t.title.trim()) return null;
        return {
          title: t.title.trim(),
          detail: typeof t.detail === "string" ? t.detail : "",
          ...(typeof t.topic === "string" && t.topic.trim() ? { topic: t.topic.trim() } : {}),
        };
      })
      .filter((t): t is { title: string; detail: string; topic?: string } => t !== null);
    if (tasks.length === 0 || tasks.length > 30) return null;
    return { tasks };
  } catch {
    return null;
  }
}

/**
 * The coach-drafted study plan as a confirm card (```plan fenced blocks).
 * Like LogEntryCard it stays live in any coach message — the plan id
 * ("plan:<messageId>") makes confirms idempotent, and confirming a NEW plan
 * deliberately replaces the old one (the card warns when that's happening).
 */
export function PlanCard({ spec }: { spec: PlanSpec }) {
  const { plan, savePlan } = useJourney();
  const { messageId } = useMessageInfo();
  const snackbar = useSnackbar();
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const planId = messageId ? `plan:${messageId}` : undefined;
  const saved = planId !== undefined && plan?.id === planId;
  const replacing = !saved && plan !== null && plan.tasks.length > 0;

  if (saved) {
    const done = plan.tasks.filter((t) => t.status === "done").length;
    return (
      <div className="plancard plancard--done">
        <Icon name="check" size={18} />
        <span className="body-medium">
          Plan saved — <strong>{done} of {plan.tasks.length}</strong> tasks done. Track it in your Journey.
        </span>
      </div>
    );
  }
  if (skipped) {
    return (
      <div className="plancard plancard--done plancard--skipped">
        <span className="body-medium">Plan not saved.</span>
        <button type="button" className="plancard__undo label-medium" onClick={() => setSkipped(false)}>
          Undo
        </button>
      </div>
    );
  }

  const confirm = async () => {
    if (!planId || saving) return;
    setSaving(true);
    try {
      await savePlan({ id: planId, source: "coach", tasks: spec.tasks });
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't save the plan");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="plancard">
      <div className="plancard__head">
        <Icon name="checklist" size={18} />
        <span className="label-large">Your study plan — {spec.tasks.length} tasks</span>
      </div>
      <ol className="plancard__list">
        {spec.tasks.map((t, i) => (
          <li key={i} className="plancard__task">
            <span className="plancard__title body-medium">{t.title}</span>
            {t.detail && <span className="plancard__detail body-medium">{t.detail}</span>}
          </li>
        ))}
      </ol>
      {replacing && (
        <p className="plancard__warn body-medium">
          This replaces your current plan ({plan.tasks.filter((t) => t.status === "done").length} of{" "}
          {plan.tasks.length} done). Completed work stays in your log.
        </p>
      )}
      <div className="plancard__actions">
        <Button variant="text" onClick={() => setSkipped(true)} disabled={saving}>
          Skip
        </Button>
        <Button icon="check" onClick={() => void confirm()} disabled={!planId || saving}>
          {saving ? "Saving…" : replacing ? "Replace plan" : "Save plan"}
        </Button>
      </div>
    </div>
  );
}
