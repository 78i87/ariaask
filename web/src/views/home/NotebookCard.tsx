import { useRef, useState } from "react";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import type { Notebook } from "../../lib/types";
import "./NotebookCard.css";

function relativeDate(iso: string | null): string {
  if (!iso) return "Never taught";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Taught today";
  if (days === 1) return "Taught yesterday";
  if (days < 30) return `Taught ${days} days ago`;
  return `Taught on ${new Date(iso).toLocaleDateString()}`;
}

interface NotebookCardProps {
  notebook: Notebook;
  index: number;
  onOpen: () => void;
  onDelete: () => void;
}

export function NotebookCard({ notebook, index, onOpen, onDelete }: NotebookCardProps) {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const meta =
    notebook.type === "topic"
      ? notebook.topic
      : `${notebook.sourceFiles.length} source${notebook.sourceFiles.length === 1 ? "" : "s"}`;

  return (
    <Card onClick={onOpen} className="nb-card" >
      <div className="nb-card__inner" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
        <div className="nb-card__top">
          <div className="nb-card__badge">
            <Icon name={notebook.type === "topic" ? "menu_book" : "upload_file"} size={20} />
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
              items={[{ icon: "delete", label: "Delete", destructive: true, onSelect: onDelete }]}
            />
          </span>
        </div>
        <div className="nb-card__title title-medium">{notebook.title}</div>
        <div className="nb-card__meta body-medium">
          {meta} · {relativeDate(notebook.lastTaughtAt)}
        </div>
      </div>
    </Card>
  );
}
