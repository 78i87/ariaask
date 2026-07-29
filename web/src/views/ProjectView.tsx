import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useSnackbar } from "../components/Snackbar";
import { TopAppBar } from "../components/TopAppBar";
import { TextField } from "../components/TextField";
import { api } from "../lib/api";
import type { ProjectActivity, SourceFile } from "../lib/types";
import { requestNewProject } from "./CoachSidebar";
import { useLearningShell } from "./LearningShell";
import { ProjectSourcesButton } from "./ProjectSourcesButton";
import { AddSourcesDialog } from "./session/AddSourcesDialog";
import { sourceIcon } from "./session/SourcesPanel";
import { SourcePreviewDialog } from "./session/SourcePreviewDialog";
import { AddActivityDialog } from "./project/AddActivityDialog";
import "./ProjectView.css";

export function EmptyProjectSources({ discovering }: { discovering: boolean }) {
  return discovering ? (
    <div className="project-view__empty" aria-live="polite">
      <ProgressIndicator size={28} />
      <span className="title-small">Finding sources…</span>
      <span className="body-medium">Useful pages will appear here as Aria adds them.</span>
    </div>
  ) : (
    <div className="project-view__empty">
      <Icon name="library_books" size={28} />
      <span className="title-small">No sources yet</span>
      <span className="body-medium">Upload notes, articles or PDFs, or let Aria find material online.</span>
    </div>
  );
}

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
  const [activityOpen, setActivityOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [preview, setPreview] = useState<SourceFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activityDeleteTarget, setActivityDeleteTarget] = useState<ProjectActivity | null>(null);
  const [activityDeleting, setActivityDeleting] = useState(false);
  const [activityRenameTarget, setActivityRenameTarget] = useState<ProjectActivity | null>(null);
  const [activityRenameDraft, setActivityRenameDraft] = useState("");
  const [activityRenaming, setActivityRenaming] = useState(false);
  const [repairTarget, setRepairTarget] = useState<ProjectActivity | null>(null);
  const [repairCvSource, setRepairCvSource] = useState("");
  const [repairing, setRepairing] = useState(false);

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

  const createActivity = async (form: FormData): Promise<ProjectActivity> => {
    if (!current) throw new Error("Project unavailable");
    const result = await api.createActivity(current.id, form);
    for (const warning of result.warnings) snackbar.show(warning);
    await refresh();
    setActivityOpen(false);
    navigate(`/project/${current.id}/activity/${result.activity.id}`);
    return result.activity;
  };

  const confirmDeleteActivity = async () => {
    if (!current || !activityDeleteTarget || activityDeleting) return;
    setActivityDeleting(true);
    try {
      await api.deleteActivity(current.id, activityDeleteTarget.id);
      setActivityDeleteTarget(null);
      await refresh();
      snackbar.show("Activity deleted");
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't delete the activity");
    } finally {
      setActivityDeleting(false);
    }
  };

  const confirmRenameActivity = async () => {
    if (!current || !activityRenameTarget || !activityRenameDraft.trim() || activityRenaming) return;
    setActivityRenaming(true);
    try {
      await api.renameActivity(current.id, activityRenameTarget.id, activityRenameDraft.trim());
      setActivityRenameTarget(null);
      await refresh();
      snackbar.show("Activity renamed");
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't rename the activity");
    } finally {
      setActivityRenaming(false);
    }
  };

  const confirmRepairActivity = async () => {
    if (!current || !repairTarget || !repairCvSource || repairing) return;
    setRepairing(true);
    try {
      await api.updateActivity(current.id, repairTarget.id, { cvSource: repairCvSource });
      setRepairTarget(null);
      await refresh();
      snackbar.show("Interview setup updated");
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't update the interview");
    } finally {
      setRepairing(false);
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
        <div className="project-view__activities">
          <div className="project-view__section-heading">
            <div>
              <span className="project-view__eyebrow label-medium">Project workspace</span>
              <h1 className="headline-medium">Activities</h1>
              <p className="body-large">Add the kind of learning conversation you need. Each activity keeps its own history.</p>
            </div>
            <Button variant="filled" icon="add" onClick={() => setActivityOpen(true)}>
              Add activity
            </Button>
          </div>

          {current.activities.length === 0 ? (
            <div className="project-view__empty">
              <Icon name="psychology" size={28} />
              <span className="title-small">No activities yet</span>
              <span className="body-medium">Start with a learning coach, reverse tutor, or interview practice.</span>
            </div>
          ) : (
            <ul className="project-view__activity-list">
              {current.activities.map((activity) => (
                <li key={activity.id} className="project-view__activity">
                  <button
                    type="button"
                    className="project-view__activity-open"
                    onClick={() => {
                      if (activity.kind === "interview" && !activity.setupComplete) {
                        setRepairTarget(activity);
                        setRepairCvSource(current.sourceFiles[0]?.storedName ?? "");
                      } else {
                        navigate(`/project/${current.id}/activity/${activity.id}`);
                      }
                    }}
                  >
                    <Icon
                      name={
                        activity.kind === "coach"
                          ? "psychology"
                          : activity.kind === "interview"
                            ? "work"
                            : "school"
                      }
                      size={22}
                    />
                    <span>
                      <span className="title-small">{activity.title}</span>
                      <span className="body-medium">
                        {activity.kind === "coach"
                          ? "Learning coach"
                          : activity.kind === "interview"
                            ? activity.setupComplete
                              ? "Interview practice"
                              : "Interview practice · CV required"
                            : "Reverse tutor"}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    icon="edit"
                    ariaLabel={`Rename ${activity.title}`}
                    onClick={() => {
                      setActivityRenameTarget(activity);
                      setActivityRenameDraft(activity.title);
                    }}
                  />
                  <IconButton
                    icon="delete"
                    ariaLabel={`Delete ${activity.title}`}
                    onClick={() => setActivityDeleteTarget(activity)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="project-view__intro">
          <div>
            <span className="project-view__eyebrow label-medium">Shared context</span>
            <h1 id="project-materials-heading" className="headline-medium">
              Sources
            </h1>
            <p className="body-large">
              Keep the project’s material here. Every activity can use these sources.
            </p>
          </div>
          <Button variant="tonal" icon="add" onClick={() => setSourcesOpen(true)}>
            Add sources
          </Button>
        </div>

        {current.sourceFiles.length === 0 ? (
          <EmptyProjectSources discovering={discovering} />
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
          discovering={discovering}
        kickoffRunning={false}
        intakePending={false}
        interview={false}
        onClose={() => setSourcesOpen(false)}
        onAdded={() => void refresh()}
        onDiscover={async (request) => {
          setDiscovering(true);
          try {
            await api.discoverSources(current.id, request);
          } catch (err) {
            setDiscovering(false);
            throw err;
          }
        }}
      />

      <AddActivityDialog
        open={activityOpen}
        project={current}
        onClose={() => setActivityOpen(false)}
        onCreate={createActivity}
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

      <Dialog
        open={activityRenameTarget !== null}
        onClose={() => {
          if (!activityRenaming) setActivityRenameTarget(null);
        }}
        headline="Rename activity"
        actions={
          <>
            <Button variant="text" onClick={() => setActivityRenameTarget(null)} disabled={activityRenaming}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmRenameActivity()}
              disabled={!activityRenameDraft.trim() || activityRenaming}
            >
              Save
            </Button>
          </>
        }
      >
        <TextField
          label="Activity name"
          value={activityRenameDraft}
          onChange={setActivityRenameDraft}
          onSubmit={() => void confirmRenameActivity()}
          autoFocus
        />
      </Dialog>

      <Dialog
        open={activityDeleteTarget !== null}
        onClose={() => {
          if (!activityDeleting) setActivityDeleteTarget(null);
        }}
        icon="delete"
        headline="Delete this activity?"
        actions={
          <>
            <Button variant="text" onClick={() => setActivityDeleteTarget(null)} disabled={activityDeleting}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDeleteActivity()} disabled={activityDeleting}>
              Delete
            </Button>
          </>
        }
      >
        <span className="body-medium">
          <strong>{activityDeleteTarget?.title}</strong> and its conversation will be permanently deleted. Shared
          sources, plans, and learning-log entries will stay in the project.
        </span>
      </Dialog>

      <Dialog
        open={repairTarget !== null}
        onClose={() => {
          if (!repairing) setRepairTarget(null);
        }}
        headline="Choose a CV"
        actions={
          <>
            <Button variant="text" onClick={() => setRepairTarget(null)} disabled={repairing}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRepairActivity()} disabled={!repairCvSource || repairing}>
              Save
            </Button>
          </>
        }
      >
        {current.sourceFiles.length > 0 ? (
          <select
            className="add-activity__select body-medium"
            value={repairCvSource}
            onChange={(event) => setRepairCvSource(event.target.value)}
          >
            {current.sourceFiles.map((source) => (
              <option key={source.storedName} value={source.storedName}>
                {source.originalName}
              </option>
            ))}
          </select>
        ) : (
          <span className="body-medium">Add the CV to shared sources first, then return to this activity.</span>
        )}
      </Dialog>
    </main>
  );
}
