import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useSnackbar } from "../components/Snackbar";
import { TopAppBar } from "../components/TopAppBar";
import { api } from "../lib/api";
import type { SourceFile } from "../lib/types";
import { requestNewProject } from "./CoachSidebar";
import { useLearningShell } from "./LearningShell";
import { ProjectSourcesButton } from "./ProjectSourcesButton";
import { AddSourcesDialog } from "./session/AddSourcesDialog";
import { sourceIcon } from "./session/SourcesPanel";
import { SourcePreviewDialog } from "./session/SourcePreviewDialog";
import "./ProjectView.css";

/** Project-level home: materials first, conversations added from the sidebar. */
export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const {
    narrow,
    sidebarCollapsed,
    setSidebarCollapsed,
    setDrawerOpen,
    projects: { notebooks, refresh },
  } = useLearningShell();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [preview, setPreview] = useState<SourceFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const current = useMemo(
    () => notebooks?.find((notebook) => notebook.id === id && !notebook.archivedAt) ?? null,
    [notebooks, id],
  );

  useEffect(() => {
    if (notebooks === null) return;
    const active = notebooks.filter((notebook) => !notebook.archivedAt);
    if ((!id || !active.some((notebook) => notebook.id === id)) && active.length > 0) {
      navigate(`/project/${active[0]!.id}`, { replace: true });
    }
  }, [id, notebooks, navigate]);

  useEffect(() => {
    if (!id) return;
    setDiscovering(false);
    const events = new EventSource(api.notebookEventsUrl(id));
    const onRefresh = () => void refresh();
    // Creation-time link ingestion may finish before this route subscribes.
    // Refresh once the stream is attached so the snapshot and subsequent
    // events cover both sides of that hand-off.
    events.addEventListener("open", onRefresh, { once: true });
    events.addEventListener("sources-updated", onRefresh);
    events.addEventListener("discover-completed", () => {
      setDiscovering(false);
      onRefresh();
    });
    events.addEventListener("state", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { discoveryRunning?: boolean };
        if (typeof data.discoveryRunning === "boolean") setDiscovering(data.discoveryRunning);
      } catch {
        /* ignore malformed reconnect state */
      }
    });
    return () => events.close();
  }, [id, refresh]);

  const confirmDeleteSource = async () => {
    if (!current || !deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteSource(current.id, deleteTarget.storedName);
      setDeleteTarget(null);
      await refresh();
      snackbar.show(`Removed "${deleteTarget.originalName}"`);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't remove the source");
    } finally {
      setDeleting(false);
    }
  };

  const leading = narrow ? (
    <IconButton icon="menu" ariaLabel="Projects" onClick={() => setDrawerOpen(true)} />
  ) : sidebarCollapsed ? (
    <span className="shell__panel-mirror">
      <IconButton icon="right_panel_open" ariaLabel="Show sidebar" onClick={() => setSidebarCollapsed(false)} />
    </span>
  ) : null;

  if (notebooks === null) {
    return (
      <main className="project-view project-view--loading">
        <ProgressIndicator />
      </main>
    );
  }

  if (!current) {
    return (
      <main className="project-view">
        <TopAppBar leading={leading} headline={<span className="title-medium">Learning projects</span>} />
        <EmptyState
          icon="library_books"
          headline="Create your first project"
          body="Add your materials first, then choose the kind of learning conversation you need."
          action={
            <Button variant="tonal" icon="add" onClick={requestNewProject}>
              New learning project
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <main className="project-view">
      <TopAppBar
        leading={leading}
        headline={<span className="title-medium">{current.title}</span>}
        trailing={
          <ProjectSourcesButton
            count={current.sourceFiles.length}
            busy={discovering}
            onClick={() => setSourcesOpen(true)}
          />
        }
      />

      <section className="project-view__content" aria-labelledby="project-materials-heading">
        <div className="project-view__intro">
          <div>
            <span className="project-view__eyebrow label-medium">Project workspace</span>
            <h1 id="project-materials-heading" className="headline-medium">
              Sources
            </h1>
            <p className="body-large">
              Keep the project’s reading material here. Use the <strong>+</strong> beside the project name to add a
              learning coach or {current.type === "interview" ? "interview practice" : "reverse tutor"}.
            </p>
          </div>
          <Button variant="tonal" icon="add" onClick={() => setSourcesOpen(true)}>
            Add sources
          </Button>
        </div>

        {current.sourceFiles.length === 0 ? (
          <div className="project-view__empty">
            <Icon name="library_books" size={28} />
            <span className="title-small">No sources yet</span>
            <span className="body-medium">Upload notes, articles or PDFs, or let Aria find material online.</span>
          </div>
        ) : (
          <ul className="project-view__sources">
            {current.sourceFiles.map((source) => (
              <li key={source.storedName} className="project-view__source">
                <button type="button" className="project-view__source-open" onClick={() => setPreview(source)}>
                  <Icon name={sourceIcon(source)} size={20} />
                  <span className="project-view__source-name body-large">{source.originalName}</span>
                </button>
                <IconButton
                  icon="delete"
                  ariaLabel={`Remove ${source.originalName}`}
                  onClick={() => setDeleteTarget(source)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddSourcesDialog
        open={sourcesOpen}
        notebookId={current.id}
        topicSuggestion={
          current.type === "interview"
            ? `${current.interview?.role ?? current.title}${current.interview?.company ? ` at ${current.interview.company}` : ""} interview questions`
            : (current.topic ?? current.title)
        }
        discovering={discovering}
        kickoffRunning={false}
        intakePending={false}
        interview={current.type === "interview"}
        onClose={() => setSourcesOpen(false)}
        onAdded={() => void refresh()}
        onDiscover={(query) => {
          setDiscovering(true);
          void api.discoverSources(current.id, { query }).catch((err) => {
            setDiscovering(false);
            snackbar.show(err instanceof Error ? err.message : "Couldn't start the search");
          });
        }}
      />

      {preview && (
        <SourcePreviewDialog notebookId={current.id} file={preview} onClose={() => setPreview(null)} />
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        icon="delete"
        headline="Remove this source?"
        actions={
          <>
            <Button variant="text" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDeleteSource()} disabled={deleting}>
              Remove
            </Button>
          </>
        }
      >
        <span className="body-medium">
          <strong>{deleteTarget?.originalName}</strong> will be removed from this project and its chats.
        </span>
      </Dialog>
    </main>
  );
}
