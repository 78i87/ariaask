import { useRef, useState } from "react";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import type { Notebook } from "../../lib/types";
import "./NotebookCard.css";

function relativeDate(iso: string | null, verb: string, never: string): string {
  if (!iso) return never;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  if (days < 30) return `${verb} ${days} days ago`;
  return `${verb} on ${new Date(iso).toLocaleDateString()}`;
}

interface NotebookCardProps {
  notebook: Notebook;
  index: number;
  onOpen: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onRename: (title: string) => Promise<boolean>;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

export function NotebookCard({ notebook, index, onOpen, onDelete, onArchive, onRestore, onRename }: NotebookCardProps) {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const cancelRename = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(notebook.title);

  const interview = notebook.type === "interview";
  const meta = interview
    ? [notebook.interview?.role, notebook.interview?.company].filter(Boolean).join(" · ") || notebook.title
    : notebook.type === "topic"
      ? notebook.topic
      : `${notebook.sourceFiles.length} source${notebook.sourceFiles.length === 1 ? "" : "s"}`;
  const showMeta = !meta || normalized(meta) !== normalized(notebook.title);

  const finishRename = async () => {
    if (cancelRename.current) {
      cancelRename.current = false;
      setDraftTitle(notebook.title);
      setRenaming(false);
      return;
    }
    const title = draftTitle.trim();
    if (!title || title === notebook.title) {
      setDraftTitle(notebook.title);
      setRenaming(false);
      return;
    }
    if (await onRename(title)) setRenaming(false);
  };

  return (
    <Card onClick={renaming ? undefined : onOpen} className="nb-card" >
      <div className="nb-card__inner" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
        <div className="nb-card__top">
          <div className="nb-card__badge">
            <Icon name={interview ? "work" : notebook.type === "topic" ? "menu_book" : "upload_file"} size={20} />
          </div>
          <span
            className="nb-card__menu-anchor"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <IconButton
              ref={menuAnchor}
              icon="more_vert"
              ariaLabel="Notebook options"
              onClick={() => setMenuOpen(true)}
            />
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorRef={menuAnchor}
              items={
                notebook.archivedAt
                  ? [
                      { icon: "unarchive", label: "Restore", onSelect: onRestore },
                      { icon: "delete", label: "Delete", destructive: true, onSelect: onDelete },
                    ]
                  : [
                      {
                        icon: "edit",
                        label: "Rename",
                        onSelect: () => {
                          setDraftTitle(notebook.title);
                          setRenaming(true);
                        },
                      },
                      { icon: "archive", label: "Archive", onSelect: onArchive },
                      { icon: "delete", label: "Delete", destructive: true, onSelect: onDelete },
                    ]
              }
            />
          </span>
        </div>
        {renaming ? (
          <input
            className="nb-card__rename title-medium"
            aria-label="Notebook title"
            value={draftTitle}
            autoFocus
            maxLength={140}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void finishRename()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelRename.current = true;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <div className="nb-card__title title-medium">{notebook.title}</div>
        )}
        <div className="nb-card__meta body-medium">
          {showMeta ? `${meta} · ` : ""}
          {interview
            ? relativeDate(notebook.lastTaughtAt, "Practiced", "Not practiced yet")
            : relativeDate(notebook.lastTaughtAt, "Taught", "Never taught")}
        </div>
      </div>
    </Card>
  );
}
