import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { RichMarkdown } from "../../components/RichMarkdown";
import { api } from "../../lib/api";
import type { SourceFile } from "../../lib/types";
import { sourceIcon } from "./SourcesPanel";
import "./SourcePreviewDialog.css";

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
  const docRef = useRef<HTMLDivElement>(null);
  const kind = kindOf(file);
  const url = api.sourceUrl(notebookId, file.storedName);

  const [text, setText] = useState<string | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">(kind === "pdf" ? "ready" : "loading");
  const [attempt, setAttempt] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [progress, setProgress] = useState(0);

  // Conditionally mounted by the caller, so open once on mount. The !open
  // guard and close-on-cleanup keep StrictMode's simulated remount (and
  // pre-2023 browsers, where a double showModal throws) well-behaved.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (kind === "pdf") return;
    const ctrl = new AbortController();
    setLoad("loading");
    api
      .sourcePreview(notebookId, file.storedName)
      .then((preview) => {
        if (ctrl.signal.aborted) return;
        setText(preview.content);
        setTruncated(preview.truncated);
        setLoad("ready");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad("error");
      });
    return () => ctrl.abort();
  }, [notebookId, file.storedName, kind, attempt]);

  const shown = text ?? "";

  useEffect(() => {
    const root = docRef.current;
    if (!root || load !== "ready") return;
    const blocks = [...root.querySelectorAll<HTMLElement>(".preview-doc__md .rich-markdown > *, .preview-doc__pre")];
    for (const block of blocks) block.classList.remove("preview-search-match", "preview-search-match--active");
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
      setMatches(0);
      setActiveMatch(0);
      return;
    }
    const found = blocks.filter((block) => (block.textContent ?? "").toLocaleLowerCase().includes(needle));
    found.forEach((block) => block.classList.add("preview-search-match"));
    setMatches(found.length);
    const nextActive = Math.min(activeMatch, Math.max(found.length - 1, 0));
    if (nextActive !== activeMatch) setActiveMatch(nextActive);
    const current = found[nextActive];
    if (current) {
      current.classList.add("preview-search-match--active");
      current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [query, activeMatch, load, shown]);

  const moveMatch = (delta: number) => {
    if (matches === 0) return;
    setActiveMatch((index) => (index + delta + matches) % matches);
  };

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
        {file.originUrl && (
          <a
            className="preview-dialog__origin label-large"
            href={file.originUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="open_in_new" size={18} />
            View original
          </a>
        )}
        <IconButton icon="close" ariaLabel="Close preview" onClick={onClose} />
      </header>
      {kind !== "pdf" && load === "ready" && (
        <div className="preview-dialog__tools">
          <label className="preview-search">
            <Icon name="search" size={18} />
            <input
              aria-label="Search source"
              value={query}
              placeholder="Find in source"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveMatch(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") moveMatch(event.shiftKey ? -1 : 1);
              }}
            />
          </label>
          <span className="preview-search__count label-medium" aria-live="polite">
            {query.trim() ? (matches ? `${activeMatch + 1} of ${matches}` : "No matches") : ""}
          </span>
          <IconButton icon="keyboard_arrow_up" ariaLabel="Previous match" disabled={matches === 0} onClick={() => moveMatch(-1)} />
          <IconButton icon="keyboard_arrow_down" ariaLabel="Next match" disabled={matches === 0} onClick={() => moveMatch(1)} />
        </div>
      )}
      <div className="preview-dialog__progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
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
          <div
            ref={docRef}
            className="preview-doc"
            onScroll={(event) => {
              const el = event.currentTarget;
              setProgress(el.scrollHeight <= el.clientHeight ? 1 : el.scrollTop / (el.scrollHeight - el.clientHeight));
            }}
          >
            {!shown.trim() ? (
              <div className="preview-dialog__status">
                <Icon name="description" size={32} />
                <span className="body-medium">This source did not contain a readable text preview.</span>
                {file.originUrl && <span className="body-medium">Open the original source to read it.</span>}
              </div>
            ) : kind === "md" ? (
              <div className="preview-doc__md body-large">
                <RichMarkdown>{shown}</RichMarkdown>
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
