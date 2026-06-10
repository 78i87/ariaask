import { Icon } from "../../components/Icon";
import type { Notebook, SourceFile } from "../../lib/types";
import "./SourcesPanel.css";

export function sourceIcon(f: SourceFile): string {
  return f.storedName.toLowerCase().endsWith(".pdf") ? "picture_as_pdf" : "description";
}

/** Middle-truncate so the extension stays visible; CSS can't do this. */
export function truncateMiddle(name: string, max = 30): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 12)}…${name.slice(-11)}`;
}

interface SourcesPanelProps {
  notebook: Notebook;
  onOpenFile: (f: SourceFile) => void;
}

export function SourcesPanel({ notebook, onOpenFile }: SourcesPanelProps) {
  return (
    <aside className="session__sources" aria-label="Source materials">
      <h2 className="session__sources-heading label-large">{notebook.type === "topic" ? "Topic" : "Sources"}</h2>
      {notebook.type === "topic" ? (
        <div className="session__source-topic">
          <Icon name="menu_book" size={20} className="session__source-icon" />
          <span className="session__source-name body-medium">{notebook.topic ?? notebook.title}</span>
        </div>
      ) : (
        <ul className="session__sources-list">
          {notebook.sourceFiles.map((f) => (
            <li key={f.storedName}>
              <button
                type="button"
                className="session__source-row"
                title={f.originalName}
                onClick={() => onOpenFile(f)}
              >
                <Icon name={sourceIcon(f)} size={20} className="session__source-icon" />
                <span className="session__source-name body-medium">{truncateMiddle(f.originalName)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
