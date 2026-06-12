import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { useSnackbar } from "../../components/Snackbar";
import { TextField } from "../../components/TextField";
import { api } from "../../lib/api";
import type { Notebook } from "../../lib/types";
import { FileDropZone } from "../home/FileDropZone";
import "./AddSourcesDialog.css";

interface AddSourcesDialogProps {
  open: boolean;
  notebookId: string;
  topicSuggestion: string;
  discovering: boolean;
  kickoffRunning: boolean;
  intakePending: boolean;
  onClose: () => void;
  onAdded: (notebook: Notebook) => void;
  onDiscover: (query: string) => void;
}

export function AddSourcesDialog({
  open,
  notebookId,
  topicSuggestion,
  discovering,
  kickoffRunning,
  intakePending,
  onClose,
  onAdded,
  onDiscover,
}: AddSourcesDialogProps) {
  const [mode, setMode] = useState<"upload" | "online">("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [query, setQuery] = useState(topicSuggestion);
  const [uploading, setUploading] = useState(false);
  const snackbar = useSnackbar();

  useEffect(() => {
    if (open) setQuery(topicSuggestion);
  }, [open, topicSuggestion]);

  const close = () => {
    if (uploading) return;
    setFiles([]);
    onClose();
  };

  const add = async () => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await api.addSources(notebookId, form);
      // One combined message — the snackbar is single-slot, so separate
      // warning toasts would be instantly replaced by the success one.
      const n = res.added.length;
      const success = `Added ${n} file${n === 1 ? "" : "s"} — the student will read ${n === 1 ? "it" : "them"} with your next message`;
      snackbar.show(res.warnings.length > 0 ? `${success}. ${res.warnings.join(" ")}` : success);
      setFiles([]);
      onAdded(res.notebook);
      onClose();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't add files");
    } finally {
      setUploading(false);
    }
  };

  const findOnline = () => {
    const trimmed = query.trim();
    if (!trimmed || discovering || kickoffRunning || intakePending) return;
    onDiscover(trimmed);
    snackbar.show("Searching the web — sources will appear as they're found.");
    onClose();
  };

  const findDisabled = !query.trim() || discovering || kickoffRunning || intakePending;
  const findSupport = discovering
    ? "Aria is already looking for sources."
    : kickoffRunning || intakePending
      ? "Online discovery is available once the session is ready."
      : "Aria searches the web and adds up to 5 pages as sources — this takes a few minutes.";

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
          ) : (
            <Button onClick={findOnline} disabled={findDisabled}>
              Find sources
            </Button>
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
          onChange={(v) => setMode(v === "online" ? "online" : "upload")}
        />
        {mode === "upload" ? (
          <FileDropZone files={files} onChange={setFiles} />
        ) : (
          <TextField
            label="What should Aria find?"
            value={query}
            onChange={setQuery}
            supportingText={findSupport}
            onSubmit={findOnline}
            autoFocus
          />
        )}
      </div>
    </Dialog>
  );
}
