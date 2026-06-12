import { Chip } from "../../components/Chip";
import type { CyraThreadSummary, ThreadSelection } from "../../lib/types";
import "./ThreadBar.css";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

interface ThreadBarProps {
  active: ThreadSelection;
  threads: CyraThreadSummary[];
  onSelect: (sel: ThreadSelection) => void;
}

/**
 * Switcher between the teaching thread (student Aria), the knowledge map, and
 * the notebook's "Ask Cyra" expert conversations. Aria, the map, and "Ask
 * question" are permanent entry points; thread chips accumulate after them.
 */
export function ThreadBar({ active, threads, onSelect }: ThreadBarProps) {
  return (
    <div className="threadbar">
      <Chip
        icon="school"
        label="Aria"
        selected={active.kind === "aria"}
        onClick={() => onSelect({ kind: "aria" })}
        className="threadbar__chip"
      />
      <Chip
        icon="hub"
        label="Knowledge map"
        selected={active.kind === "map"}
        onClick={() => onSelect({ kind: "map" })}
        className="threadbar__chip"
      />
      <div className="threadbar__divider" />
      <div className="threadbar__scroll">
        <Chip
          icon="history_edu"
          label="Ask question"
          selected={active.kind === "cyra" && active.threadId === null}
          onClick={() => onSelect({ kind: "cyra", threadId: null })}
          className="threadbar__chip threadbar__chip--cyra"
        />
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
