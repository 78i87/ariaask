import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { api } from "../../lib/api";
import type { SourceFile } from "../../lib/types";
import { sourceIcon } from "./SourcesPanel";
import "./SourcePreviewDialog.css";

/** Above this, .md falls back to plain text — parsing huge markdown blocks the main thread. */
const MD_PARSE_LIMIT = 200_000;
/** Hard cap on rendered characters. */
const TEXT_DISPLAY_LIMIT = 500_000;

type Kind = "pdf" | "md" | "txt";

function kindOf(f: SourceFile): Kind {
  const n = f.storedName.toLowerCase();
  return n.endsWith(".pdf") ? "pdf" : n.endsWith(".md") ? "md" : "txt";
}

interface SourcePreviewDialogProps {
  notebookId: string;
  file: SourceFile;
  onClose: () => void;
}

export function SourcePreviewDialog({ notebookId, file, onClose }: SourcePreviewDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const kind = kindOf(file);
  const url = api.sourceUrl(notebookId, file.storedName);

  const [text, setText] = useState<string | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">(kind === "pdf" ? "ready" : "loading");
  const [attempt, setAttempt] = useState(0);

  // Conditionally mounted by the caller, so open once on mount.
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    if (kind === "pdf") return;
    const ctrl = new AbortController();
    setLoad("loading");
    fetch(url, { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((t) => {
        setText(t);
        setLoad("ready");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad("error");
      });
    return () => ctrl.abort();
  }, [url, kind, attempt]);

  const truncated = text !== null && text.length > TEXT_DISPLAY_LIMIT;
  const shown = truncated ? text!.slice(0, TEXT_DISPLAY_LIMIT) : (text ?? "");
  const renderMarkdown = kind === "md" && shown.length <= MD_PARSE_LIMIT;

  return (
    <dialog
      ref={ref}
      className="preview-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="preview-dialog__header">
        <Icon name={sourceIcon(file)} size={22} className="preview-dialog__file-icon" />
        <span className="preview-dialog__name title-medium" title={file.originalName}>
          {file.originalName}
        </span>
        <IconButton icon="close" ariaLabel="Close preview" onClick={onClose} />
      </header>
      <div className="preview-dialog__content">
        {kind === "pdf" ? (
          <iframe className="preview-dialog__pdf" src={url} title={file.originalName} />
        ) : load === "loading" ? (
          <div className="preview-dialog__status">
            <ProgressIndicator />
          </div>
        ) : load === "error" ? (
          <div className="preview-dialog__status">
            <Icon name="error" size={32} className="preview-dialog__error-icon" />
            <span className="body-medium">Couldn't load this file.</span>
            <Button variant="text" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="preview-doc">
            {renderMarkdown ? (
              <div className="preview-doc__md body-large">
                <Markdown remarkPlugins={[remarkGfm]}>{shown}</Markdown>
              </div>
            ) : (
              <pre className="preview-doc__pre body-medium">{shown}</pre>
            )}
            {truncated && (
              <p className="preview-doc__truncated body-medium">
                Preview truncated — showing the first 500,000 characters.
              </p>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}
