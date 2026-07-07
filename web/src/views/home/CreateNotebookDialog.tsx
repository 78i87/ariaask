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

export function CreateNotebookDialog({ open, onClose, onCreate, onCreated }: CreateNotebookDialogProps) {
  // Two levels: what you're doing (teach Aria vs. be interviewed by Cyra),
  // then — for teaching only — where the material comes from.
  const [experience, setExperience] = useState<"teach" | "interview">("teach");
  const [teachMode, setTeachMode] = useState<"topic" | "files">("topic");
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [jdTab, setJdTab] = useState<"paste" | "link">("paste");
  const [jobDescription, setJobDescription] = useState("");
  const [jobDescriptionUrl, setJobDescriptionUrl] = useState("");
  const [cvTab, setCvTab] = useState<"upload" | "paste">("upload");
  const [cvText, setCvText] = useState("");
  const [cvFiles, setCvFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const snackbar = useSnackbar();

  const mode = experience === "interview" ? "interview" : teachMode;

  const canCreate =
    mode === "topic"
      ? topic.trim().length > 0
      : mode === "files"
        ? files.length > 0
        : role.trim().length > 0 && (cvTab === "upload" ? cvFiles.length > 0 : cvText.trim().length > 0);

  const reset = () => {
    setExperience("teach");
    setTeachMode("topic");
    setTopic("");
    setTitle("");
    setFiles([]);
    setRole("");
    setCompany("");
    setJdTab("paste");
    setJobDescription("");
    setJobDescriptionUrl("");
    setCvTab("upload");
    setCvText("");
    setCvFiles([]);
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
      if (title.trim()) form.set("title", title.trim());
      if (mode === "topic") {
        form.set("topic", topic.trim());
      } else if (mode === "files") {
        for (const f of files) form.append("files", f);
      } else {
        form.set("role", role.trim());
        if (company.trim()) form.set("company", company.trim());
        // Only the active tab submits — an abandoned draft on the other tab never leaks.
        if (jdTab === "paste" && jobDescription.trim()) form.set("jobDescription", jobDescription.trim());
        if (jdTab === "link" && jobDescriptionUrl.trim()) form.set("jobDescriptionUrl", jobDescriptionUrl.trim());
        if (cvTab === "upload") {
          for (const f of cvFiles) form.append("files", f);
        } else {
          form.set("cvText", cvText.trim());
        }
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
      headline="New notebook"
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
      <div className="create-nb__mode" role="radiogroup" aria-label="Notebook type">
        {(["teach", "interview"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={experience === m}
            className={`create-nb__segment label-large${experience === m ? " create-nb__segment--selected" : ""}`}
            onClick={() => setExperience(m)}
          >
            {experience === m && <Icon name="check" size={18} />}
            {m === "teach" ? "Teach" : "Interview"}
          </button>
        ))}
      </div>

      {experience === "teach" ? (
        <>
          <Segmented
            dense
            options={[
              { value: "topic", label: "Topic" },
              { value: "files", label: "Upload sources" },
            ]}
            value={teachMode}
            onChange={(v) => setTeachMode(v as "topic" | "files")}
            ariaLabel="Teaching material"
          />
          {teachMode === "topic" ? (
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
        </>
      ) : (
        <>
          <TextField
            label="Target role"
            value={role}
            onChange={setRole}
            autoFocus
            supportingText='e.g. "Senior frontend engineer"'
          />
          <TextField label="Company (optional)" value={company} onChange={setCompany} />
          <div className="create-nb__cv">
            <span className="create-nb__cv-caption label-large">Job description (optional)</span>
            <Segmented
              dense
              options={[
                { value: "paste", label: "Paste" },
                { value: "link", label: "Link" },
              ]}
              value={jdTab}
              onChange={(v) => setJdTab(v as "paste" | "link")}
              ariaLabel="Job description input"
            />
            {jdTab === "paste" ? (
              <TextField
                label="Paste the posting"
                value={jobDescription}
                onChange={setJobDescription}
                multiline
                rows={4}
                supportingText="Cyra tailors her questions to it"
              />
            ) : (
              <TextField
                label="Link to the posting"
                value={jobDescriptionUrl}
                onChange={setJobDescriptionUrl}
                supportingText="Cyra fetches and reads the page when the notebook is created"
              />
            )}
          </div>
          <div className="create-nb__cv">
            <span className="create-nb__cv-caption label-large">Your CV</span>
            <Segmented
              dense
              options={[
                { value: "upload", label: "Upload" },
                { value: "paste", label: "Paste" },
              ]}
              value={cvTab}
              onChange={(v) => setCvTab(v as "upload" | "paste")}
              ariaLabel="CV input"
            />
            {cvTab === "upload" ? (
              <FileDropZone
                files={cvFiles}
                onChange={setCvFiles}
                maxFiles={1}
                hint="Drop your CV here or click to browse"
              />
            ) : (
              <TextField label="Paste your CV" value={cvText} onChange={setCvText} multiline rows={6} />
            )}
          </div>
        </>
      )}

      <TextField
        label="Title (optional)"
        value={title}
        onChange={setTitle}
        supportingText="Leave blank to name it automatically"
      />
    </Dialog>
  );
}
