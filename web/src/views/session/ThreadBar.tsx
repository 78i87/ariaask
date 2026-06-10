import { Chip } from "../../components/Chip";
import type { CyraThreadSummary, ThreadSelection } from "../../lib/types";
import "./ThreadBar.css";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

interface ThreadBarProps {
  active: ThreadSelection;
  threads: CyraThreadSummary[];
  /** True while an unsent "Ask Cyra" draft exists (renders the provisional chip). */
  showDraft: boolean;
  onSelect: (sel: ThreadSelection) => void;
}

/**
 * Switcher between the teaching thread (student Aria) and the notebook's
 * "Ask Cyra" expert conversations. Hidden entirely until the first Cyra
 * interaction so plain teaching sessions look exactly as before.
 */
export function ThreadBar({ active, threads, showDraft, onSelect }: ThreadBarProps) {
  if (threads.length === 0 && !showDraft) return null;
  return (
    <div className="threadbar">
      <Chip
        icon="school"
        label="Aria"
        selected={active.kind === "aria"}
        onClick={() => onSelect({ kind: "aria" })}
        className="threadbar__chip"
      />
      <div className="threadbar__divider" />
      <div className="threadbar__scroll">
        {showDraft && (
          <Chip
            icon="history_edu"
            label="New question"
            selected={active.kind === "cyra" && active.threadId === null}
            onClick={() => onSelect({ kind: "cyra", threadId: null })}
            className="threadbar__chip threadbar__chip--cyra"
          />
        )}
        {threads.map((t) => (
          <Chip
            key={t.id}
            icon="history_edu"
            label={truncate(t.title, 32)}
            selected={active.kind === "cyra" && active.threadId === t.id}
            onClick={() => onSelect({ kind: "cyra", threadId: t.id })}
            className="threadbar__chip threadbar__chip--cyra"
          />
        ))}
      </div>
    </div>
  );
}
