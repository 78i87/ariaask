import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { TextField } from "../../components/TextField";
import { useSnackbar } from "../../components/Snackbar";
import { FileDropZone } from "./FileDropZone";
import type { Notebook } from "../../lib/types";
import "./CreateNotebookDialog.css";

interface CreateNotebookDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (form: FormData) => Promise<{ notebook: Notebook; warnings: string[] }>;
  onCreated: (notebook: Notebook) => void;
}

const LEVELS = [
  { value: "new to this", label: "New to this" },
  { value: "know some basics", label: "Know some basics" },
  { value: "comfortable — going deeper", label: "Going deeper" },
];

/**
 * Deliberately three things only: what to learn, how familiar you are, and
 * (optionally, collapsed) materials — files or pasted links. Goal/deadline
 * calibration moved into the coach's opening conversation, and with no
 * materials the coach's greeting offers clickable ways to get some.
 */
export function CreateNotebookDialog({ open, onClose, onCreate, onCreated }: CreateNotebookDialogProps) {
  const [topic, setTopic] = useState("");
  const [level, setLevel] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState("");
  const [showMaterials, setShowMaterials] = useState(false);
  const [creating, setCreating] = useState(false);
  const snackbar = useSnackbar();

  const canCreate = topic.trim().length > 0;

  const reset = () => {
    setTopic("");
    setLevel(null);
    setFiles([]);
    setLinks("");
    setShowMaterials(false);
  };

  const close = () => {
    if (creating) return;
    reset();
    onClose();
  };

  const create = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const form = new FormData();
      form.set("type", "topic");
      form.set("coachFirst", "1");
      form.set("topic", topic.trim());
      if (level) form.set("current", level);
      if (links.trim()) form.set("links", links.trim());
      for (const f of files) form.append("files", f);
      const res = await onCreate(form);
      for (const w of res.warnings) snackbar.show(w);
      reset();
      onCreated(res.notebook);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't create the project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      headline="New learning project"
      actions={
        <>
          <Button variant="text" onClick={close} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!canCreate || creating}>
            {creating ? <ProgressIndicator size={18} /> : "Create"}
          </Button>
        </>
      }
    >
      <TextField
        label="What do you want to learn?"
        value={topic}
        onChange={setTopic}
        autoFocus
        supportingText="A topic, skill, module, or subject — anything"
        onSubmit={() => void create()}
      />

      <div className="create-nb__level">
        <span className="create-nb__label label-large">How familiar are you with it?</span>
        <Segmented
          ariaLabel="Familiarity"
          options={LEVELS}
          value={level ?? ""}
          onChange={(v) => setLevel(v === level ? v : v)}
        />
      </div>

      {!showMaterials ? (
        <div>
          <Button variant="text" icon="add" onClick={() => setShowMaterials(true)}>
            Add materials (optional)
          </Button>
        </div>
      ) : (
        <div className="create-nb__materials">
          <span className="create-nb__label label-large">
            <Icon name="library_books" size={16} /> Materials (optional)
          </span>
          <FileDropZone files={files} onChange={setFiles} />
          <textarea
            className="create-nb__links body-medium"
            rows={3}
            placeholder={"Paste links — articles, PDFs, YouTube videos (one per line)"}
            value={links}
            onChange={(e) => setLinks(e.target.value)}
          />
          <span className="create-nb__hint body-medium">
            No materials? No problem — your coach will help you find some.
          </span>
        </div>
      )}
    </Dialog>
  );
}
