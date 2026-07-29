import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { TextField } from "../../components/TextField";
import { useSnackbar } from "../../components/Snackbar";
import type { Notebook } from "../../lib/types";
import { FileDropZone } from "./FileDropZone";
import "./CreateNotebookDialog.css";

interface CreateNotebookDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (form: FormData) => Promise<{ notebook: Notebook; warnings: string[] }>;
  onCreated: (notebook: Notebook) => void;
}

export function CreateNotebookDialog({ open, onClose, onCreate, onCreated }: CreateNotebookDialogProps) {
  const [goal, setGoal] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState("");
  const [showMaterials, setShowMaterials] = useState(false);
  const [creating, setCreating] = useState(false);
  const snackbar = useSnackbar();

  const reset = () => {
    setGoal("");
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
    if (!goal.trim() || creating) return;
    setCreating(true);
    try {
      const form = new FormData();
      form.set("goal", goal.trim());
      if (links.trim()) form.set("links", links.trim());
      for (const file of files) form.append("files", file);
      const response = await onCreate(form);
      for (const warning of response.warnings) snackbar.show(warning);
      reset();
      onCreated(response.notebook);
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't create the project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      headline="New project"
      actions={
        <>
          <Button variant="text" onClick={close} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!goal.trim() || creating}>
            {creating ? <ProgressIndicator size={18} /> : "Create"}
          </Button>
        </>
      }
    >
      <TextField
        label="What are you working on?"
        value={goal}
        onChange={setGoal}
        autoFocus
        supportingText="A topic, role, exam, skill, or project"
        onSubmit={() => void create()}
      />
      {!showMaterials ? (
        <div>
          <Button variant="text" icon="add" onClick={() => setShowMaterials(true)}>
            Add materials (optional)
          </Button>
        </div>
      ) : (
        <div className="create-nb__materials">
          <span className="create-nb__label label-large">
            <Icon name="library_books" size={16} /> Shared materials (optional)
          </span>
          <FileDropZone files={files} onChange={setFiles} />
          <textarea
            className="create-nb__links body-medium"
            rows={3}
            placeholder="Paste links — articles, PDFs, YouTube videos (one per line)"
            value={links}
            onChange={(event) => setLinks(event.target.value)}
          />
          <span className="create-nb__hint body-medium">Every activity in this project can use these materials.</span>
        </div>
      )}
    </Dialog>
  );
}
