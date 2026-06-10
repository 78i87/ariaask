import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import type { Notebook } from "../../lib/types";
import { FileDropZone } from "../home/FileDropZone";

interface AddSourcesDialogProps {
  open: boolean;
  notebookId: string;
  onClose: () => void;
  onAdded: (notebook: Notebook) => void;
}

export function AddSourcesDialog({ open, notebookId, onClose, onAdded }: AddSourcesDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const snackbar = useSnackbar();

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
          <Button onClick={() => void add()} disabled={files.length === 0 || uploading}>
            {uploading ? <ProgressIndicator size={18} /> : "Add"}
          </Button>
        </>
      }
    >
      <FileDropZone files={files} onChange={setFiles} />
    </Dialog>
  );
}
