import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { useSnackbar } from "../../components/Snackbar";
import { TextField } from "../../components/TextField";
import { api } from "../../lib/api";
import type { DiscoveryClarificationQuestion, DiscoveryRequest, Notebook } from "../../lib/types";
import { FileDropZone } from "../home/FileDropZone";
import "./AddSourcesDialog.css";

interface AddSourcesDialogProps {
  open: boolean;
  notebookId: string;
  discovering: boolean;
  kickoffRunning: boolean;
  intakePending: boolean;
  interview?: boolean;
  activityId?: string;
  initialMode?: "upload" | "online";
  onClose: () => void;
  onAdded: (notebook: Notebook) => void;
  onDiscover: (request: DiscoveryRequest) => Promise<void>;
}

export function AddSourcesDialog({
  open,
  notebookId,
  discovering,
  kickoffRunning,
  intakePending,
  interview,
  activityId,
  initialMode = "upload",
  onClose,
  onAdded,
  onDiscover,
}: AddSourcesDialogProps) {
  const [mode, setMode] = useState<"upload" | "online">("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [asCv, setAsCv] = useState(false);
  const [request, setRequest] = useState("");
  const [onlineStep, setOnlineStep] = useState<"request" | "questions">("request");
  const [questions, setQuestions] = useState<DiscoveryClarificationQuestion[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [clarifying, setClarifying] = useState(false);
  const [tailored, setTailored] = useState(true);
  const [startingDiscovery, setStartingDiscovery] = useState(false);
  const [uploading, setUploading] = useState(false);
  const snackbar = useSnackbar();

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setRequest("");
    setOnlineStep("request");
    setQuestions([]);
    setSelected({});
    setCustomText({});
    setClarifying(false);
    setTailored(true);
    setStartingDiscovery(false);
  }, [open, initialMode]);

  const close = () => {
    if (uploading || startingDiscovery) return;
    setFiles([]);
    setAsCv(false);
    onClose();
  };

  const add = async () => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await api.addSources(notebookId, form);
      let notebook = res.notebook;
      if (interview && asCv && activityId && res.added[0]) {
        const updated = await api.updateActivity(notebookId, activityId, {
          cvSource: res.added[0].storedName,
        });
        notebook = updated.notebook;
      }
      // One combined message — the snackbar is single-slot, so separate
      // warning toasts would be instantly replaced by the success one.
      const n = res.added.length;
      const success = `Added ${n} file${n === 1 ? "" : "s"} — ${interview ? "Cyra" : "the student"} will read ${n === 1 ? "it" : "them"} with your next message`;
      snackbar.show(res.warnings.length > 0 ? `${success}. ${res.warnings.join(" ")}` : success);
      setFiles([]);
      setAsCv(false);
      onAdded(notebook);
      onClose();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't add files");
    } finally {
      setUploading(false);
    }
  };

  const clarifyOnline = async () => {
    const trimmed = request.trim();
    if (!trimmed || clarifying || discovering || kickoffRunning || intakePending) return;
    setClarifying(true);
    try {
      const result = await api.clarifyDiscovery(notebookId, {
        request: trimmed,
        ...(activityId ? { activityId } : {}),
      });
      setQuestions(result.questions);
      setSelected({});
      setCustomText({});
      setTailored(result.tailored);
      setOnlineStep("questions");
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't prepare the source search");
    } finally {
      setClarifying(false);
    }
  };

  const answerFor = (question: DiscoveryClarificationQuestion): string => {
    const value = selected[question.id];
    if (value === "__custom__") return (customText[question.id] ?? "").trim();
    return value?.trim() ?? "";
  };

  const findOnline = async () => {
    const trimmed = request.trim();
    if (
      !trimmed ||
      discovering ||
      kickoffRunning ||
      intakePending ||
      startingDiscovery ||
      questions.some((question) => !answerFor(question))
    ) {
      return;
    }
    setStartingDiscovery(true);
    try {
      await onDiscover({
        request: trimmed,
        refinements: questions.map((question) => ({
          question: question.question,
          answer: answerFor(question),
        })),
        ...(activityId ? { activityId } : {}),
      });
      snackbar.show("Searching the web — sources will appear as they're found.");
      onClose();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't start the search");
    } finally {
      setStartingDiscovery(false);
    }
  };

  const who = interview ? "Cyra" : "Aria";
  const unavailable = discovering || kickoffRunning || intakePending;
  const continueDisabled = !request.trim() || clarifying || unavailable;
  const findDisabled =
    !request.trim() ||
    unavailable ||
    startingDiscovery ||
    questions.some((question) => !answerFor(question));
  const findSupport = discovering
    ? `${who} is already looking for sources.`
    : kickoffRunning || intakePending
      ? "Online discovery is available once the session is ready."
      : "Describe the outcome you need, not search keywords. Aria will ask only what would improve the results.";

  return (
    <Dialog
      open={open}
      onClose={close}
      headline="Add sources"
      actions={
        <>
          <Button variant="text" onClick={close} disabled={uploading}>
            Cancel
          </Button>
          {mode === "upload" ? (
            <Button onClick={() => void add()} disabled={files.length === 0 || uploading}>
              {uploading ? <ProgressIndicator size={18} /> : "Add"}
            </Button>
          ) : onlineStep === "request" ? (
            <Button onClick={() => void clarifyOnline()} disabled={continueDisabled}>
              {clarifying ? <ProgressIndicator size={18} /> : "Continue"}
            </Button>
          ) : (
            <>
              <Button variant="text" onClick={() => setOnlineStep("request")} disabled={startingDiscovery}>
                Back
              </Button>
              <Button onClick={() => void findOnline()} disabled={findDisabled}>
                {startingDiscovery ? <ProgressIndicator size={18} /> : "Find sources"}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="add-sources">
        <Segmented
          ariaLabel="Add source mode"
          value={mode}
          options={[
            { value: "upload", label: "Upload files" },
            { value: "online", label: "Find online" },
          ]}
          onChange={(v) => {
            setMode(v === "online" ? "online" : "upload");
            setOnlineStep("request");
          }}
        />
        {mode === "upload" ? (
          <>
            <FileDropZone
              files={files}
              onChange={setFiles}
              maxFiles={interview && asCv ? 1 : undefined}
            />
            {interview && activityId && (
              <Chip
                icon="contact_page"
                label="This is my updated CV"
                selected={asCv}
                onClick={() => {
                  const next = !asCv;
                  setAsCv(next);
                  if (next) setFiles((selectedFiles) => selectedFiles.slice(0, 1));
                }}
              />
            )}
          </>
        ) : onlineStep === "request" ? (
          <TextField
            label="What should these sources help you do?"
            value={request}
            onChange={setRequest}
            supportingText={findSupport}
            onSubmit={() => void clarifyOnline()}
            autoFocus
          />
        ) : (
          <div className="add-sources__questions">
            <div className={`add-sources__readiness body-medium${tailored ? "" : " add-sources__readiness--warning"}`}>
              <Icon name={tailored ? "psychology" : "priority_high"} size={20} />
              <span>
                {!tailored
                  ? "Aria couldn't tailor follow-up questions this time. You can still search from your request."
                  : questions.length === 0
                    ? "Aria has enough context to search well."
                    : "A little more context will help Aria choose better sources."}
              </span>
            </div>
            {questions.map((question) => (
              <fieldset key={question.id} className="add-sources__question" disabled={startingDiscovery}>
                <legend className="label-large">{question.question}</legend>
                <div className="add-sources__options" role="radiogroup" aria-label={question.question}>
                  {question.options.map((option) => {
                    const checked = selected[question.id] === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        className={`add-sources__option${checked ? " add-sources__option--selected" : ""}`}
                        onClick={() => setSelected((current) => ({ ...current, [question.id]: option.value }))}
                      >
                        <span>{option.label}</span>
                        {checked && <Icon name="check" size={18} />}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected[question.id] === "__custom__"}
                    className={`add-sources__option${
                      selected[question.id] === "__custom__" ? " add-sources__option--selected" : ""
                    }`}
                    onClick={() => setSelected((current) => ({ ...current, [question.id]: "__custom__" }))}
                  >
                    <span>Other…</span>
                    {selected[question.id] === "__custom__" && <Icon name="check" size={18} />}
                  </button>
                </div>
                {selected[question.id] === "__custom__" && (
                  <TextField
                    label="Describe it your way"
                    value={customText[question.id] ?? ""}
                    onChange={(value) => setCustomText((current) => ({ ...current, [question.id]: value }))}
                    autoFocus
                  />
                )}
              </fieldset>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
