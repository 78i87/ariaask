import { Chip } from "../../components/Chip";
import type { CyraThreadSummary, ThreadSelection } from "../../lib/types";
import "./ThreadBar.css";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

interface CyraChipsProps {
  /** null = nothing highlighted; { threadId: null } = the new-question view. */
  selected: { threadId: string | null } | null;
  threads: CyraThreadSummary[];
  onSelect: (threadId: string | null) => void;
}

/**
 * The "Ask Cyra" entry points: the permanent "Ask question" chip plus one
 * chip per conversation. Rendered inside the ThreadBar in tabbed mode, and in
 * the split pane's own bar (SessionView) when split chat is on.
 */
export function CyraChips({ selected, threads, onSelect }: CyraChipsProps) {
  return (
    <>
      <Chip
        icon="history_edu"
        label="Ask question"
        selected={selected !== null && selected.threadId === null}
        onClick={() => onSelect(null)}
        className="threadbar__chip threadbar__chip--cyra"
      />
      {threads.map((t) => (
        <Chip
          key={t.id}
          icon="history_edu"
          label={truncate(t.title, 32)}
          selected={selected?.threadId === t.id}
          onClick={() => onSelect(t.id)}
          className="threadbar__chip threadbar__chip--cyra"
        />
      ))}
    </>
  );
}

interface ThreadBarProps {
  active: ThreadSelection;
  threads: CyraThreadSummary[];
  onSelect: (sel: ThreadSelection) => void;
  /** Split-chat mode: the Cyra chips live in the right pane's bar instead. */
  split?: boolean;
}

/**
 * Switcher between the teaching thread (student Aria), the knowledge map, and
 * the notebook's "Ask Cyra" expert conversations. Aria, the map, and "Ask
 * question" are permanent entry points; thread chips accumulate after them.
 */
export function ThreadBar({ active, threads, onSelect, split }: ThreadBarProps) {
  return (
    <div className="threadbar">
      <Chip
        icon="school"
        label="Aria"
        selected={active.kind === "aria"}
        onClick={() => onSelect({ kind: "aria" })}
        className="threadbar__chip"
      />
      {!split && (
        <>
          <div className="threadbar__divider" />
          <div className="threadbar__scroll">
            <CyraChips
              selected={active.kind === "cyra" ? { threadId: active.threadId } : null}
              threads={threads}
              onSelect={(threadId) => onSelect({ kind: "cyra", threadId })}
            />
          </div>
        </>
      )}
    </div>
  );
}
