import { useRef, useState } from "react";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import { useSnackbar } from "../../components/Snackbar";
import "./FileDropZone.css";

const ACCEPTED = [".txt", ".md", ".pdf"];
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

function middleTruncate(name: string, max = 24): string {
  if (name.length <= max) return name;
  const half = Math.floor((max - 1) / 2);
  return `${name.slice(0, half)}…${name.slice(-half)}`;
}

interface FileDropZoneProps {
  files: File[];
  onChange: (files: File[]) => void;
}

export function FileDropZone({ files, onChange }: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const snackbar = useSnackbar();

  const addFiles = (incoming: FileList | File[]) => {
    const list = [...incoming];
    let accepted = list.filter((f) => ACCEPTED.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (accepted.length < list.length) {
      snackbar.show("Only txt, md and pdf files are supported");
    }
    if (accepted.some((f) => f.size > MAX_FILE_SIZE)) {
      snackbar.show("Each file must be under 25MB");
      accepted = accepted.filter((f) => f.size <= MAX_FILE_SIZE);
    }
    const existing = new Set(files.map(fileKey));
    let merged = [...files, ...accepted.filter((f) => !existing.has(fileKey(f)))];
    if (merged.length > MAX_FILES) {
      snackbar.show("You can upload at most 10 files");
      merged = merged.slice(0, MAX_FILES);
    }
    onChange(merged);
  };

  return (
    <div className="dropzone-wrap">
      <div
        className={`dropzone${dragOver ? " dropzone--over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="upload_file" size={32} fill={dragOver ? 1 : 0} />
        <span className="body-medium">Drag files here or click to browse</span>
        <span className="dropzone__formats body-medium">txt, md, pdf</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(",")}
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="dropzone__files">
          {files.map((f) => (
            <Chip
              key={fileKey(f)}
              icon="description"
              label={middleTruncate(f.name)}
              onRemove={() => onChange(files.filter((x) => fileKey(x) !== fileKey(f)))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
