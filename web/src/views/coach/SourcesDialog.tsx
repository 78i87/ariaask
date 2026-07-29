import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import { readingEligible } from "../../lib/types";
import type { Notebook, ReadingSessionSummary, SourceFile } from "../../lib/types";
import { sourceIcon } from "../session/SourcesPanel";
import { SourcePreviewDialog } from "../session/SourcePreviewDialog";
import "./SourcesDialog.css";

interface SourcesDialogProps {
  open: boolean;
  notebook: Notebook;
  onClose: () => void;
  /** Open the add-materials dialog (upload / find online). */
  onAddMaterials: () => void;
  /** Open the new-guided-reading setup preselected to this source. */
  onNewReading: (storedName: string) => void;
  onRefresh: () => void;
}



/**
 * The project's sources hub: every source listed with preview, original link,
 * delete, and — for guided-reading-eligible PDFs — a one-tap reading action
 * that resumes the existing session when one exists, else starts the setup.
 */
export function SourcesDialog({ open, notebook, onClose, onAddMaterials, onNewReading, onRefresh }: SourcesDialogProps) {
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const [readings, setReadings] = useState<ReadingSessionSummary[] | null>(null);
  const [preview, setPreview] = useState<SourceFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceFile | null>(null);

  useEffect(() => {
    if (!open) return;
    setReadings(null);
    api.listReadings(notebook.id).then(
      (res) => setReadings(res.sessions),
      () => setReadings([]),
    );
  }, [open, notebook.id]);

  /** Newest usable reading for a source, if any. */
  const readingFor = (storedName: string): ReadingSessionSummary | undefined =>
    [...(readings ?? [])]
      .reverse()
      .find((r) => r.source === storedName && (r.status === "ready" || r.status === "generating"));

  const openReading = (f: SourceFile) => {
    const existing = readingFor(f.storedName);
    if (existing) {
      onClose();
      navigate(`/learn/${notebook.id}/read/${existing.id}`);
    } else {
      onNewReading(f.storedName);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await api.deleteSource(notebook.id, target.storedName);
      onRefresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't delete the source");
    }
  };

  return (
    <>
      <Dialog
        open={open && !preview}
        onClose={onClose}
        icon="library_books"
        headline="Sources"
        actions={
          <>
            <Button variant="text" onClick={onClose}>
              Close
            </Button>
            <Button icon="add" onClick={onAddMaterials}>
              Add materials
            </Button>
          </>
        }
      >
        {notebook.sourceFiles.length === 0 ? (
          <p className="srcs__empty body-medium">
            No sources yet. Add lecture slides, chapters, papers or links — or ask your coach to find
            some online.
          </p>
        ) : (
          <div className="srcs__list">
            {notebook.sourceFiles.map((f) => {
              const existing = readingEligible(f) ? readingFor(f.storedName) : undefined;
              return (
                <div key={f.storedName} className="srcs__row">
                  <button type="button" className="srcs__open" onClick={() => setPreview(f)} title="Preview">
                    <Icon name={sourceIcon(f)} size={20} />
                    <span className="srcs__name body-medium">{f.originalName}</span>
                    <span className="srcs__meta label-medium">
                      {f.approxWords !== null ? `${Math.round(f.approxWords / 100) / 10}k words` : ""}
                    </span>
                  </button>
                  {f.originUrl && (
                    <a className="srcs__link" href={f.originUrl} target="_blank" rel="noreferrer" title="View original">
                      <Icon name="open_in_new" size={18} />
                    </a>
                  )}
                  {readingEligible(f) &&
                    (readings === null ? (
                      <span className="srcs__spinner">
                        <ProgressIndicator size={18} />
                      </span>
                    ) : (
                      <IconButton
                        icon="auto_stories"
                        ariaLabel={
                          existing
                            ? existing.status === "generating"
                              ? "Guided reading (preparing…)"
                              : "Continue guided reading"
                            : "Start guided reading"
                        }
                        fill={existing ? 1 : 0}
                        onClick={() => openReading(f)}
                      />
                    ))}
                  <IconButton icon="delete" ariaLabel={`Delete ${f.originalName}`} onClick={() => setDeleteTarget(f)} />
                </div>
              );
            })}
          </div>
        )}
      </Dialog>

      {preview && <SourcePreviewDialog notebookId={notebook.id} file={preview} onClose={() => setPreview(null)} />}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        icon="delete"
        headline="Delete this source?"
        actions={
          <>
            <Button variant="text" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <span className="body-medium">
          <strong>{deleteTarget?.originalName}</strong> will be removed from this project.
        </span>
      </Dialog>
    </>
  );
}
