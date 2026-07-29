import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { useSnackbar } from "../../components/Snackbar";
import { TextField } from "../../components/TextField";
import type { ActivityKind, Notebook, ProjectActivity } from "../../lib/types";
import { FileDropZone } from "../home/FileDropZone";
import "./AddActivityDialog.css";

interface AddActivityDialogProps {
  open: boolean;
  project: Notebook;
  onClose: () => void;
  onCreate: (form: FormData) => Promise<ProjectActivity>;
}

export function AddActivityDialog({ open, project, onClose, onCreate }: AddActivityDialogProps) {
  const [kind, setKind] = useState<ActivityKind | null>(null);
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [cvMode, setCvMode] = useState<"existing" | "upload" | "paste">(
    project.sourceFiles.length > 0 ? "existing" : "upload",
  );
  const [cvSource, setCvSource] = useState(project.sourceFiles[0]?.storedName ?? "");
  const [cvFiles, setCvFiles] = useState<File[]>([]);
  const [cvText, setCvText] = useState("");
  const [jdMode, setJdMode] = useState<"none" | "existing" | "paste" | "link">("none");
  const [jobDescriptionSource, setJobDescriptionSource] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobDescriptionUrl, setJobDescriptionUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const snackbar = useSnackbar();

  const reset = () => {
    setKind(null);
    setRole("");
    setCompany("");
    setCvMode(project.sourceFiles.length > 0 ? "existing" : "upload");
    setCvSource(project.sourceFiles[0]?.storedName ?? "");
    setCvFiles([]);
    setCvText("");
    setJdMode("none");
    setJobDescriptionSource("");
    setJobDescription("");
    setJobDescriptionUrl("");
  };

  const close = () => {
    if (creating) return;
    reset();
    onClose();
  };

  const create = async (selectedKind: ActivityKind = kind!) => {
    if (creating) return;
    setCreating(true);
    try {
      const form = new FormData();
      form.set("kind", selectedKind);
      if (selectedKind === "interview") {
        form.set("role", role.trim());
        if (company.trim()) form.set("company", company.trim());
        if (cvMode === "existing") form.set("cvSource", cvSource);
        if (cvMode === "upload" && cvFiles[0]) form.append("files", cvFiles[0]);
        if (cvMode === "paste") form.set("cvText", cvText.trim());
        if (jdMode === "existing") form.set("jobDescriptionSource", jobDescriptionSource);
        if (jdMode === "paste") form.set("jobDescription", jobDescription.trim());
        if (jdMode === "link") form.set("jobDescriptionUrl", jobDescriptionUrl.trim());
      }
      await onCreate(form);
      reset();
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't add the activity");
    } finally {
      setCreating(false);
    }
  };

  const canCreateInterview =
    role.trim().length > 0 &&
    ((cvMode === "existing" && cvSource.length > 0) ||
      (cvMode === "upload" && cvFiles.length > 0) ||
      (cvMode === "paste" && cvText.trim().length > 0));

  return (
    <Dialog
      open={open}
      onClose={close}
      headline={kind === "interview" ? "Set up interview practice" : "Add activity"}
      actions={
        kind === "interview" ? (
          <>
            <Button variant="text" onClick={() => setKind(null)} disabled={creating}>
              Back
            </Button>
            <Button onClick={() => void create()} disabled={!canCreateInterview || creating}>
              {creating ? <ProgressIndicator size={18} /> : "Add interview"}
            </Button>
          </>
        ) : (
          <Button variant="text" onClick={close} disabled={creating}>
            Cancel
          </Button>
        )
      }
    >
      {kind === null ? (
        <div className="add-activity__choices">
          {[
            {
              kind: "coach" as const,
              icon: "psychology" as const,
              title: "Learning coach",
              body: "Plan how to learn and choose the right techniques.",
            },
            {
              kind: "reverse-tutor" as const,
              icon: "school" as const,
              title: "Reverse tutor",
              body: "Teach Aria and expose gaps through her questions.",
            },
            {
              kind: "interview" as const,
              icon: "work" as const,
              title: "Interview practice",
              body: "Run a realistic interview grounded in your CV.",
            },
          ].map((choice) => (
            <button
              key={choice.kind}
              type="button"
              className="add-activity__choice"
              disabled={creating}
              onClick={() => {
                if (choice.kind === "interview") setKind(choice.kind);
                else void create(choice.kind);
              }}
            >
              <Icon name={choice.icon} size={24} />
              <span>
                <strong className="title-small">{choice.title}</strong>
                <span className="body-medium">{choice.body}</span>
              </span>
              {creating && <ProgressIndicator size={18} />}
            </button>
          ))}
        </div>
      ) : (
        <div className="add-activity__interview">
          <TextField
            label="Target role"
            value={role}
            onChange={setRole}
            autoFocus
            supportingText='e.g. "Senior frontend engineer"'
          />
          <TextField label="Company (optional)" value={company} onChange={setCompany} />

          <div className="add-activity__field">
            <span className="label-large">Your CV</span>
            <Segmented
              dense
              ariaLabel="CV input"
              options={[
                ...(project.sourceFiles.length > 0 ? [{ value: "existing", label: "Project source" }] : []),
                { value: "upload", label: "Upload" },
                { value: "paste", label: "Paste" },
              ]}
              value={cvMode}
              onChange={(value) => setCvMode(value as typeof cvMode)}
            />
            {cvMode === "existing" ? (
              <select
                className="add-activity__select body-medium"
                value={cvSource}
                onChange={(event) => setCvSource(event.target.value)}
              >
                {project.sourceFiles.map((source) => (
                  <option key={source.storedName} value={source.storedName}>
                    {source.originalName}
                  </option>
                ))}
              </select>
            ) : cvMode === "upload" ? (
              <FileDropZone files={cvFiles} onChange={setCvFiles} maxFiles={1} hint="Drop your CV here" />
            ) : (
              <TextField label="Paste your CV" value={cvText} onChange={setCvText} multiline rows={5} />
            )}
          </div>

          <div className="add-activity__field">
            <span className="label-large">Job description (optional)</span>
            <Segmented
              dense
              ariaLabel="Job description input"
              options={[
                { value: "none", label: "None" },
                ...(project.sourceFiles.length > 0 ? [{ value: "existing", label: "Project source" }] : []),
                { value: "paste", label: "Paste" },
                { value: "link", label: "Link" },
              ]}
              value={jdMode}
              onChange={(value) => setJdMode(value as typeof jdMode)}
            />
            {jdMode === "existing" ? (
              <select
                className="add-activity__select body-medium"
                value={jobDescriptionSource}
                onChange={(event) => setJobDescriptionSource(event.target.value)}
              >
                <option value="">Choose a source</option>
                {project.sourceFiles.map((source) => (
                  <option key={source.storedName} value={source.storedName}>
                    {source.originalName}
                  </option>
                ))}
              </select>
            ) : jdMode === "paste" ? (
              <TextField
                label="Paste the posting"
                value={jobDescription}
                onChange={setJobDescription}
                multiline
                rows={4}
              />
            ) : jdMode === "link" ? (
              <TextField label="Link to the posting" value={jobDescriptionUrl} onChange={setJobDescriptionUrl} />
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
