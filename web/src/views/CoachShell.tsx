import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { IconButton } from "../components/IconButton";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useSnackbar } from "../components/Snackbar";
import { TopAppBar } from "../components/TopAppBar";
import { api } from "../lib/api";
import { PLAN_REQUEST_MESSAGE, quickReturnMessage, startTaskMessage } from "../lib/journeyMessages";
import type { DueTopic, LearningLogEntry, SourceFile, StudyPlan } from "../lib/types";
import { useMediaQuery } from "../lib/useMediaQuery";
import { CoachChatView } from "./coach/CoachChatView";
import { CoachActionsContext, type CoachActions } from "./coach/coachActions";
import { JourneyContext, type Journey } from "./coach/journeyContext";
import { JourneyDialog } from "./coach/JourneyDialog";
import { SourcesDialog } from "./coach/SourcesDialog";
import { requestNewProject } from "./CoachSidebar";
import { useLearningShell } from "./LearningShell";
import { ProjectSourcesButton } from "./ProjectSourcesButton";
import { ReadingDialog } from "./reading/ReadingDialog";
import { AddSourcesDialog } from "./session/AddSourcesDialog";
import { SourcePreviewDialog } from "./session/SourcePreviewDialog";
import { sourceIcon, SourcesPanel } from "./session/SourcesPanel";
import "./CoachShell.css";

/**
 * The coach conversation inside the persistent project shell. The same
 * project sources are available to coaching, reverse tutoring and interview
 * practice; the top-right Sources control owns the desktop panel toggle.
 */
export function CoachShell() {
  const { id, aid } = useParams<{ id: string; aid: string }>();
  const navigate = useNavigate();
  const {
    narrow,
    sidebarCollapsed,
    setSidebarCollapsed,
    setDrawerOpen,
    refreshSidebarReadings,
    projects: { notebooks, refresh },
  } = useLearningShell();
  const snackbar = useSnackbar();
  const sourcesPanelAvailable = useMediaQuery("(min-width: 1141px)");

  const [sourcesHubOpen, setSourcesHubOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourcesInitialMode, setSourcesInitialMode] = useState<"upload" | "online">("upload");
  const [readingOpen, setReadingOpen] = useState(false);
  const [readingPreselect, setReadingPreselect] = useState<string | null>(null);
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [ragBuilding, setRagBuilding] = useState(false);
  const [ragBuildFailed, setRagBuildFailed] = useState(false);
  const [preview, setPreview] = useState<SourceFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sourcesCollapsed, setSourcesCollapsed] = useState(
    () => localStorage.getItem("aria-sources-collapsed") === "1",
  );

  const current = useMemo(
    () => notebooks?.find((notebook) => notebook.id === id && !notebook.archivedAt) ?? null,
    [notebooks, id],
  );

  // Link ingestion, uploads from other tabs and online discovery all announce
  // on the project SSE channel. Keep every source surface in sync.
  useEffect(() => {
    if (!id || !aid) return;
    setDiscovering(false);
    const es = new EventSource(api.notebookEventsUrl(id));
    const onRefresh = () => void refresh();
    es.addEventListener("open", onRefresh, { once: true });
    es.addEventListener("sources-updated", onRefresh);
    es.addEventListener("discover-completed", (event) => {
      onRefresh();
      setDiscovering(false);
      try {
        const data = JSON.parse((event as MessageEvent).data) as { added?: unknown[] };
        const count = data.added?.length ?? 0;
        snackbar.show(
          count > 0
            ? `Found ${count} source${count === 1 ? "" : "s"} online`
            : "The search found no usable sources",
        );
      } catch {
        // The source refresh above is the important part.
      }
    });
    es.addEventListener("state", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          discoveryRunning?: boolean;
          ragBuilding?: boolean;
          ragBuildFailed?: boolean;
        };
        if (typeof data.discoveryRunning === "boolean") setDiscovering(data.discoveryRunning);
        if (typeof data.ragBuilding === "boolean") setRagBuilding(data.ragBuilding);
        if (typeof data.ragBuildFailed === "boolean") setRagBuildFailed(data.ragBuildFailed);
      } catch {
        // Ignore malformed transient state.
      }
    });
    return () => es.close();
  }, [id, refresh, snackbar]);

  const coachActions = useMemo<CoachActions>(
    () => ({
      openAddSources: () => {
        setSourcesInitialMode("upload");
        setSourcesOpen(true);
      },
      findSources: () => {
        setSourcesInitialMode("online");
        setSourcesOpen(true);
      },
    }),
    [],
  );

  const [logEntries, setLogEntries] = useState<LearningLogEntry[]>([]);
  const [dueTopics, setDueTopics] = useState<DueTopic[]>([]);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);

  const refreshJourney = useCallback(() => {
    if (!id) return;
    api.getLog(id).then(
      (result) => {
        setLogEntries(result.entries);
        setDueTopics(result.due);
      },
      () => {},
    );
    api.getPlan(id).then(
      (result) => setStudyPlan(result.plan),
      () => {},
    );
  }, [id]);

  useEffect(() => {
    setLogEntries([]);
    setDueTopics([]);
    setStudyPlan(null);
    refreshJourney();
  }, [refreshJourney]);

  const journey = useMemo<Journey>(
    () => ({
      entries: logEntries,
      due: dueTopics,
      plan: studyPlan,
      refresh: refreshJourney,
      addEntry: async (body) => {
        if (!id) throw new Error("No project selected");
        const result = await api.addLogEntry(id, body);
        setLogEntries((previous) =>
          previous.some((entry) => entry.id === result.entry.id) ? previous : [...previous, result.entry],
        );
        setDueTopics(result.due);
        return result.entry;
      },
      savePlan: async (body) => {
        if (!id) throw new Error("No project selected");
        const result = await api.savePlan(id, body);
        setStudyPlan(result.plan);
        return result.plan;
      },
      setTaskStatus: async (taskId, status) => {
        if (!id) throw new Error("No project selected");
        const result = await api.updatePlanTask(id, taskId, status);
        setStudyPlan(result.plan);
      },
    }),
    [id, logEntries, dueTopics, studyPlan, refreshJourney],
  );

  const sendJourneyMessage = (text: string) => {
    const activityId = aid;
    if (!id || !activityId) return;
    setJourneyOpen(false);
    void api
      .sendCoachMessage(id, activityId, { text, clientMessageId: crypto.randomUUID() })
      .catch((error) => snackbar.show(error instanceof Error ? error.message : "Couldn't reach the coach"));
  };

  const toggleSources = (collapsed: boolean) => {
    setSourcesCollapsed(collapsed);
    localStorage.setItem("aria-sources-collapsed", collapsed ? "1" : "0");
  };

  const confirmDeleteSource = async () => {
    if (!current || !deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteSource(current.id, deleteTarget.storedName);
      setDeleteTarget(null);
      await refresh();
      snackbar.show(`Removed "${deleteTarget.originalName}"`);
    } catch (error) {
      snackbar.show(error instanceof Error ? error.message : "Couldn't remove the source");
    } finally {
      setDeleting(false);
    }
  };

  // "/" and stale ids resolve to the newest active project.
  useEffect(() => {
    if (notebooks === null) return;
    const active = notebooks.filter((notebook) => !notebook.archivedAt);
    if ((!id || !active.some((notebook) => notebook.id === id)) && active.length > 0) {
      navigate(`/project/${active[0]!.id}`, { replace: true });
    }
  }, [id, notebooks, navigate]);

  const showSidebarButton = narrow ? (
    <IconButton icon="menu" ariaLabel="Projects" onClick={() => setDrawerOpen(true)} />
  ) : sidebarCollapsed ? (
    <span className="shell__panel-mirror">
      <IconButton icon="right_panel_open" ariaLabel="Show sidebar" onClick={() => setSidebarCollapsed(false)} />
    </span>
  ) : null;

  return (
    <>
      <main className="shell__main">
        {current ? (
          <>
            <TopAppBar
              leading={showSidebarButton}
              headline={<h1 className="shell__page-title title-medium">{current.title}</h1>}
              trailing={
                <>
                  <Chip
                    icon="timeline"
                    label={dueTopics.length > 0 ? `Journey · ${dueTopics.length}` : "Journey"}
                    onClick={() => setJourneyOpen(true)}
                  />
                  <Chip icon="auto_stories" label="Guided reading" onClick={() => setReadingOpen(true)} />
                  <ProjectSourcesButton
                    count={current.sourceFiles.length}
                    busy={discovering}
                    expanded={sourcesPanelAvailable ? !sourcesCollapsed : undefined}
                    onClick={() => {
                      if (sourcesPanelAvailable) toggleSources(!sourcesCollapsed);
                      else setSourcesHubOpen(true);
                    }}
                  />
                </>
              }
            />

            <div className="session__body">
              <div className="session__content">
                {current.sourceFiles.length > 0 || discovering ? (
                  <div className="session__chips">
                    {current.sourceFiles.map((source) => (
                      <Chip
                        key={source.storedName}
                        icon={sourceIcon(source)}
                        label={source.originalName}
                        onClick={() => setPreview(source)}
                      />
                    ))}
                    {discovering && <Chip icon="travel_explore" label="Finding sources…" />}
                  </div>
                ) : null}

                <CoachActionsContext.Provider value={coachActions}>
                  <JourneyContext.Provider value={journey}>
                    <CoachChatView key={`${current.id}:${aid}`} notebookId={current.id} activityId={aid!} />
                  </JourneyContext.Provider>
                </CoachActionsContext.Provider>
              </div>

              <div className={`session__sources-wrap${sourcesCollapsed ? " session__sources-wrap--closed" : ""}`}>
                <SourcesPanel
                  notebook={current}
                  discovering={discovering}
                  ragBuilding={ragBuilding}
                  ragBuildFailed={ragBuildFailed}
                  onOpenFile={setPreview}
                  onDeleteFile={setDeleteTarget}
                  onAddSource={() => {
                    setSourcesInitialMode("upload");
                    setSourcesOpen(true);
                  }}
                />
              </div>
            </div>
          </>
        ) : notebooks === null ? (
          <div className="shell__empty">
            <ProgressIndicator />
          </div>
        ) : (
          <div className="shell__empty">
            {showSidebarButton && <div className="shell__empty-menu">{showSidebarButton}</div>}
            <EmptyState
              icon="psychology"
              headline="What do you want to learn?"
              body="Your coach helps you learn anything — the right technique for the right task, at the right stage."
              action={
                <Button variant="tonal" icon="add" onClick={requestNewProject}>
                  New learning project
                </Button>
              }
            />
          </div>
        )}
      </main>

      {current && (
        <ReadingDialog
          open={readingOpen}
          notebook={current}
          preselectSource={readingPreselect ?? undefined}
          onClose={() => {
            setReadingOpen(false);
            setReadingPreselect(null);
            refreshSidebarReadings();
          }}
        />
      )}

      {current && (
        <JourneyContext.Provider value={journey}>
          <JourneyDialog
            open={journeyOpen}
            notebookId={current.id}
            onClose={() => setJourneyOpen(false)}
            onQuickReturn={(topic) => sendJourneyMessage(quickReturnMessage(topic))}
            onStartTask={(position, title) => sendJourneyMessage(startTaskMessage(position, title))}
            onRequestPlan={() => sendJourneyMessage(PLAN_REQUEST_MESSAGE)}
          />
        </JourneyContext.Provider>
      )}

      {current && (
        <SourcesDialog
          open={sourcesHubOpen}
          notebook={current}
          discovering={discovering}
          onClose={() => setSourcesHubOpen(false)}
          onAddMaterials={() => {
            setSourcesHubOpen(false);
            setSourcesInitialMode("upload");
            setSourcesOpen(true);
          }}
          onNewReading={(storedName) => {
            setSourcesHubOpen(false);
            setReadingPreselect(storedName);
            setReadingOpen(true);
          }}
          onRefresh={() => void refresh()}
        />
      )}

      {current && (
        <AddSourcesDialog
          open={sourcesOpen}
          notebookId={current.id}
          discovering={discovering}
          kickoffRunning={false}
          intakePending={false}
          interview={false}
          activityId={aid}
          initialMode={sourcesInitialMode}
          onClose={() => setSourcesOpen(false)}
          onAdded={() => void refresh()}
          onDiscover={async (request) => {
            setDiscovering(true);
            try {
              await api.discoverSources(current.id, request);
            } catch (error) {
              setDiscovering(false);
              throw error;
            }
          }}
        />
      )}

      {current && preview && (
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
    </>
  );
}
