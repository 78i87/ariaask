import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import type { Notebook, SourceFile } from "../../lib/types";
import "./SourcesPanel.css";

export function sourceIcon(f: SourceFile): string {
  if (f.origin === "research") return "travel_explore";
  return f.storedName.toLowerCase().endsWith(".pdf") ? "picture_as_pdf" : "description";
}

/** Middle-truncate so the extension stays visible; CSS can't do this. */
export function truncateMiddle(name: string, max = 30): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 12)}…${name.slice(-11)}`;
}

interface SourcesPanelProps {
  notebook: Notebook;
  discovering: boolean;
  /** True while the reading-recall index is being (re)built. */
  ragBuilding: boolean;
  /** True when the most recent build failed — suppresses the "ready" line. */
  ragBuildFailed: boolean;
  onOpenFile: (f: SourceFile) => void;
  onDeleteFile: (f: SourceFile) => void;
}

export function SourcesPanel({ notebook, discovering, ragBuilding, ragBuildFailed, onOpenFile, onDeleteFile }: SourcesPanelProps) {
  const [deleteMode, setDeleteMode] = useState(false);
  /** Brief "ready" confirmation after a build finishes while we're watching. */
  const [recallReady, setRecallReady] = useState(false);
  const sawBuild = useRef(false);

  useEffect(() => {
    if (ragBuilding) {
      sawBuild.current = true;
      setRecallReady(false);
      return;
    }
    // Falling edge only — no flash on mount or notebook switch, and never
    // after a failed build (recall isn't actually ready then; builds fail open).
    if (!sawBuild.current) return;
    sawBuild.current = false;
    if (ragBuildFailed) return;
    setRecallReady(true);
    const t = setTimeout(() => setRecallReady(false), 4000);
    return () => clearTimeout(t);
  }, [ragBuilding, ragBuildFailed]);

  useEffect(() => {
    sawBuild.current = false;
    setRecallReady(false);
  }, [notebook.id]);

  // Exit delete mode when switching notebooks (the component instance is
  // reused across /notebook/:id routes)...
  useEffect(() => {
    setDeleteMode(false);
  }, [notebook.id]);
  // ...and when the last file disappears — the panel renders null then, and
  // must not reappear in delete mode after files are added again.
  useEffect(() => {
    if (notebook.sourceFiles.length === 0) setDeleteMode(false);
  }, [notebook.sourceFiles.length]);

  // The notebook's topic already titles the app bar — the panel is files-only.
  if (notebook.sourceFiles.length === 0 && !discovering) return null;

  return (
    <aside className="session__sources" aria-label="Source materials">
      <div className="session__sources-header">
        <h2 className="session__sources-heading label-large">Sources</h2>
        {notebook.sourceFiles.length > 0 && (
          <IconButton
            icon={deleteMode ? "close" : "delete"}
            ariaLabel={deleteMode ? "Done removing sources" : "Remove sources"}
            onClick={() => setDeleteMode((m) => !m)}
          />
        )}
      </div>
      {discovering ? (
        <div className="session__sources-progress">
          <ProgressIndicator size={16} />
          <span className="body-medium">Finding sources…</span>
        </div>
      ) : ragBuilding ? (
        <div className="session__sources-progress">
          <ProgressIndicator size={16} />
          <span className="body-medium">Preparing reading recall…</span>
        </div>
      ) : recallReady ? (
        <div className="session__sources-progress">
          <Icon name="check" size={16} className="session__sources-progress-check" />
          <span className="body-medium">Reading recall ready</span>
        </div>
      ) : null}
      <ul className="session__sources-list">
        {notebook.sourceFiles.map((f) => (
          <li key={f.storedName} className="session__source-li">
            <button type="button" className="session__source-row" title={f.originalName} onClick={() => onOpenFile(f)}>
              <Icon name={sourceIcon(f)} size={20} className="session__source-icon" />
              <span className="session__source-name body-medium">{truncateMiddle(f.originalName)}</span>
            </button>
            {deleteMode && (
              <button
                type="button"
                className="session__source-delete"
                aria-label={`Remove ${f.originalName}`}
                title={`Remove ${f.originalName}`}
                onClick={() => onDeleteFile(f)}
              >
                <Icon name="close" size={18} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
