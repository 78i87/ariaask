import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import type { Notebook, ReadingLevel, ReadingSessionSummary } from "../../lib/types";
import "./ReadingDialog.css";

const LEVEL_HINTS: Record<ReadingLevel, string> = {
  beginner: "Full guidance — prompts at every key passage showing when to pause, simplify, compare, connect and judge.",
  intermediate: "Lighter guidance — fewer prompts that name the thinking move but leave the how to you.",
  experienced: "You find the key passages yourself — at most a few nudges, with the focus on after-reading steps.",
};

interface ReadingDialogProps {
  open: boolean;
  notebook: Notebook;
  onClose: () => void;
}

/**
 * Entry point for guided reading: resume an existing session or pick a PDF
 * source + scaffolding level and create one. Levels implement the
 * scaffolds-fade-toward-independence progression from the knowledge base.
 */
export function ReadingDialog({ open, notebook, onClose }: ReadingDialogProps) {
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const [sessions, setSessions] = useState<ReadingSessionSummary[] | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [level, setLevel] = useState<ReadingLevel>("beginner");
  const [levelNudge, setLevelNudge] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const pdfs = notebook.sourceFiles.filter((f) => f.storedName.toLowerCase().endsWith(".pdf") && f.extractedName);

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    api.listReadings(notebook.id).then(
      (res) => setSessions([...res.sessions].reverse()),
      () => setSessions([]),
    );
    // Scaffold fading (kb: scaffolds-to-independence): after ~5 uses of a
    // level, default the picker one step lighter and say why. The user can
    // always step back up.
    api.getUsage().then(
      ({ usage }) => {
        const uses = (lvl: ReadingLevel) => usage.techniques[`guided-reading:${lvl}`]?.uses ?? 0;
        if (uses("intermediate") >= 5) {
          setLevel("experienced");
          setLevelNudge(
            `You've done ${uses("intermediate")} intermediate readings — time to find the key passages yourself.`,
          );
        } else if (uses("beginner") >= 5) {
          setLevel("intermediate");
          setLevelNudge(
            `You've done ${uses("beginner")} learner-mode readings — the prompts should be coming to you by now.`,
          );
        }
      },
      () => {},
    );
    setSource((prev) => prev ?? pdfs[0]?.storedName ?? null);
    // pdfs derives from notebook, stable while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notebook.id]);

  const sourceName = (storedName: string) =>
    notebook.sourceFiles.find((f) => f.storedName === storedName)?.originalName ?? storedName;

  const create = async () => {
    if (!source || creating) return;
    setCreating(true);
    try {
      const res = await api.createReading(notebook.id, { source, level });
      onClose();
      navigate(`/learn/${notebook.id}/read/${res.session.id}`);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't start the reading");
    } finally {
      setCreating(false);
    }
  };

  const remove = async (rid: string) => {
    try {
      await api.deleteReading(notebook.id, rid);
      setSessions((prev) => prev?.filter((s) => s.id !== rid) ?? null);
    } catch {
      snackbar.show("Couldn't delete the reading");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="auto_stories"
      headline="Guided reading"
      actions={
        <>
          <Button variant="text" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!source || creating}>
            {creating ? <ProgressIndicator size={18} /> : "Start reading"}
          </Button>
        </>
      }
    >
      {sessions === null ? (
        <div className="rdd__loading">
          <ProgressIndicator size={24} />
        </div>
      ) : (
        sessions.length > 0 && (
          <div className="rdd__section">
            <span className="rdd__label label-large">Continue</span>
            {sessions.map((s) => (
              <div key={s.id} className="rdd__session">
                <button
                  type="button"
                  className="rdd__session-open"
                  onClick={() => {
                    onClose();
                    navigate(`/learn/${notebook.id}/read/${s.id}`);
                  }}
                >
                  <Icon name="auto_stories" size={18} />
                  <span className="rdd__session-name body-medium">{sourceName(s.source)}</span>
                  <span className="rdd__session-meta label-medium">
                    {s.level} ·{" "}
                    {s.status === "generating" ? "preparing…" : s.status === "failed" ? "failed" : `${s.annotationCount} prompts`}
                  </span>
                </button>
                <IconButton icon="delete" ariaLabel="Delete reading" onClick={() => void remove(s.id)} />
              </div>
            ))}
          </div>
        )
      )}

      <div className="rdd__section">
        <span className="rdd__label label-large">New guided reading</span>
        {pdfs.length === 0 ? (
          <p className="rdd__empty body-medium">
            Guided reading works with PDF sources. Add a PDF (a paper, a chapter, lecture notes) via
            the Sources button first.
          </p>
        ) : (
          <>
            {pdfs.map((f) => (
              <button
                key={f.storedName}
                type="button"
                role="radio"
                aria-checked={source === f.storedName}
                className={`rdd__pdf${source === f.storedName ? " rdd__pdf--selected" : ""}`}
                onClick={() => setSource(f.storedName)}
              >
                {source === f.storedName ? <Icon name="check" size={18} /> : <Icon name="picture_as_pdf" size={18} />}
                <span className="body-medium">{f.originalName}</span>
              </button>
            ))}
            <Segmented
              ariaLabel="Reading level"
              options={[
                { value: "beginner", label: "Learner" },
                { value: "intermediate", label: "Intermediate" },
                { value: "experienced", label: "Experienced" },
              ]}
              value={level}
              onChange={(v) => setLevel(v as ReadingLevel)}
            />
            {levelNudge && (
              <p className="rdd__nudge body-medium">
                <Icon name="psychology" size={16} /> {levelNudge}
              </p>
            )}
            <p className="rdd__hint body-medium">{LEVEL_HINTS[level]}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
