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

export function CreateNotebookDialog({ open, onClose, onCreate, onCreated }: CreateNotebookDialogProps) {
  const [experience, setExperience] = useState<"learn" | "interview">("learn");
  const [topic, setTopic] = useState("");
  const [level, setLevel] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState("");
  const [showMaterials, setShowMaterials] = useState(false);

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

  const canCreate =
    experience === "learn"
      ? topic.trim().length > 0
      : role.trim().length > 0 && (cvTab === "upload" ? cvFiles.length > 0 : cvText.trim().length > 0);

  const reset = () => {
    setExperience("learn");
    setTopic("");
    setLevel(null);
    setFiles([]);
    setLinks("");
    setShowMaterials(false);
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
      form.set("projectFirst", "1");
      if (experience === "learn") {
        form.set("type", "topic");
        form.set("topic", topic.trim());
        if (level) form.set("current", level);
        if (links.trim()) form.set("links", links.trim());
        for (const file of files) form.append("files", file);
      } else {
        form.set("type", "interview");
        form.set("role", role.trim());
        if (company.trim()) form.set("company", company.trim());
        if (jdTab === "paste" && jobDescription.trim()) form.set("jobDescription", jobDescription.trim());
        if (jdTab === "link" && jobDescriptionUrl.trim()) {
          form.set("jobDescriptionUrl", jobDescriptionUrl.trim());
        }
        if (cvTab === "upload") {
          for (const file of cvFiles) form.append("files", file);
        } else {
          form.set("cvText", cvText.trim());
        }
      }
      const response = await onCreate(form);
      for (const warning of response.warnings) snackbar.show(warning);
      reset();
      onCreated(response.notebook);
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
      headline="New project"
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
      <div className="create-nb__mode" role="radiogroup" aria-label="Project type">
        {(["learn", "interview"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={experience === mode}
            className={`create-nb__segment label-large${experience === mode ? " create-nb__segment--selected" : ""}`}
            onClick={() => setExperience(mode)}
          >
            {experience === mode && <Icon name="check" size={18} />}
            {mode === "learn" ? "Learn" : "Interview"}
          </button>
        ))}
      </div>

      {experience === "learn" ? (
        <>
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
              onChange={(value) => setLevel(value)}
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
                placeholder="Paste links — articles, PDFs, YouTube videos (one per line)"
                value={links}
                onChange={(event) => setLinks(event.target.value)}
              />
              <span className="create-nb__hint body-medium">
                No materials? Your coach can help you find some.
              </span>
            </div>
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
              onChange={(value) => setJdTab(value as "paste" | "link")}
              ariaLabel="Job description input"
            />
            {jdTab === "paste" ? (
              <TextField
                label="Paste the posting"
                value={jobDescription}
                onChange={setJobDescription}
                multiline
                rows={4}
                supportingText="Cyra tailors the interview to it"
              />
            ) : (
              <TextField
                label="Link to the posting"
                value={jobDescriptionUrl}
                onChange={setJobDescriptionUrl}
                supportingText="Aria fetches the page when the project is created"
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
              onChange={(value) => setCvTab(value as "upload" | "paste")}
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
    </Dialog>
  );
}
