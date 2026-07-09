import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
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
  /** Coach-shell creation: the project opens on the coach; Aria intake is deferred to first teach-back. */
  coachFirst?: boolean;
}

export function CreateNotebookDialog({ open, onClose, onCreate, onCreated, coachFirst }: CreateNotebookDialogProps) {
  const [mode, setMode] = useState<"topic" | "files">("topic");
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [goal, setGoal] = useState("");
  const [current, setCurrent] = useState("");
  const [deadline, setDeadline] = useState("");
  const [creating, setCreating] = useState(false);
  const snackbar = useSnackbar();

  const canCreate = mode === "topic" ? topic.trim().length > 0 : files.length > 0;

  const reset = () => {
    setMode("topic");
    setTopic("");
    setTitle("");
    setFiles([]);
    setGoal("");
    setCurrent("");
    setDeadline("");
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
      form.set("type", mode);
      if (coachFirst) {
        form.set("coachFirst", "1");
        if (goal.trim()) form.set("goal", goal.trim());
        if (current.trim()) form.set("current", current.trim());
        if (deadline.trim()) form.set("deadline", deadline.trim());
      }
      if (title.trim()) form.set("title", title.trim());
      if (mode === "topic") {
        form.set("topic", topic.trim());
      } else {
        for (const f of files) form.append("files", f);
      }
      const res = await onCreate(form);
      for (const w of res.warnings) snackbar.show(w);
      reset();
      onCreated(res.notebook);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't create notebook");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      headline={coachFirst ? "New learning project" : "New notebook"}
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
      <div className="create-nb__mode" role="radiogroup" aria-label="Notebook source">
        {(["topic", "files"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`create-nb__segment label-large${mode === m ? " create-nb__segment--selected" : ""}`}
            onClick={() => setMode(m)}
          >
            {mode === m && <Icon name="check" size={18} />}
            {m === "topic" ? "Topic" : "Upload sources"}
          </button>
        ))}
      </div>

      {mode === "topic" ? (
        <TextField
          label="What do you want to learn?"
          value={topic}
          onChange={setTopic}
          autoFocus
          supportingText="e.g. How transformers work, the Krebs cycle, monads"
          onSubmit={() => void create()}
        />
      ) : (
        <FileDropZone files={files} onChange={setFiles} />
      )}

      <TextField
        label="Title (optional)"
        value={title}
        onChange={setTitle}
        supportingText="Leave blank to name it automatically"
      />

      {coachFirst && (
        <div className="create-nb__calibration">
          <span className="create-nb__calibration-label label-large">
            Help your coach calibrate <span className="create-nb__optional">(optional — skips the first questions)</span>
          </span>
          <TextField
            label="What do you want to be able to do?"
            value={goal}
            onChange={setGoal}
            supportingText="e.g. pass the final, build a small app, explain it in interviews"
          />
          <TextField
            label="Where are you starting from?"
            value={current}
            onChange={setCurrent}
            supportingText="e.g. total beginner, took the intro course, rusty"
          />
          <TextField label="Any deadline?" value={deadline} onChange={setDeadline} supportingText="e.g. exam on June 20" />
        </div>
      )}
    </Dialog>
  );
}
