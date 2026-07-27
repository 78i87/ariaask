import { useLayoutEffect, useRef, useState } from "react";
import { Chip } from "../../components/Chip";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import { useMediaQuery } from "../../lib/useMediaQuery";
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
 * The "Ask Cyra" entry points: the permanent action chip plus one
 * chip per conversation. Rendered inside the ThreadBar in tabbed mode, and in
 * the split pane's own bar (SessionView) when split chat is on.
 */
export function CyraChips({ selected, threads, onSelect }: CyraChipsProps) {
  return (
    <>
      <Chip
        icon="history_edu"
        label="Ask Cyra"
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
  const mobile = useMediaQuery("(max-width: 720px)");
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedThread = active.kind === "cyra" && active.threadId ? threads.find((thread) => thread.id === active.threadId) : null;
  const menuThreads = threads.filter((thread) => thread.id !== selectedThread?.id);

  useLayoutEffect(() => {
    if (mobile) return;
    scrollRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active, threads, mobile]);

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
          {mobile ? (
            <div className="threadbar__mobile-cyra">
              <Chip
                icon="history_edu"
                label="Ask Cyra"
                selected={active.kind === "cyra" && active.threadId === null}
                onClick={() => onSelect({ kind: "cyra", threadId: null })}
                className="threadbar__chip threadbar__chip--cyra"
              />
              {selectedThread && (
                <Chip
                  icon="history_edu"
                  label={truncate(selectedThread.title, 22)}
                  selected
                  onClick={() => onSelect({ kind: "cyra", threadId: selectedThread.id })}
                  className="threadbar__chip threadbar__chip--cyra"
                />
              )}
              {menuThreads.length > 0 && (
                <>
                  <IconButton ref={menuAnchor} icon="more_horiz" ariaLabel="More conversations" onClick={() => setMenuOpen(true)} />
                  <Menu
                    open={menuOpen}
                    onClose={() => setMenuOpen(false)}
                    anchorRef={menuAnchor}
                    items={menuThreads.map((thread) => ({
                      icon: "history_edu",
                      label: truncate(thread.title, 32),
                      onSelect: () => onSelect({ kind: "cyra", threadId: thread.id }),
                    }))}
                  />
                </>
              )}
            </div>
          ) : (
            <div ref={scrollRef} className="threadbar__scroll">
              <CyraChips
                selected={active.kind === "cyra" ? { threadId: active.threadId } : null}
                threads={threads}
                onSelect={(threadId) => onSelect({ kind: "cyra", threadId })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
