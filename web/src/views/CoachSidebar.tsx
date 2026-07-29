import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { Menu } from "../components/Menu";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useSnackbar } from "../components/Snackbar";
import { TextField } from "../components/TextField";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { NotebooksController } from "../lib/useNotebooks";
import { useTheme } from "../lib/theme";
import type { GlobalDueTopic, Notebook, ReadingSessionSummary } from "../lib/types";
import { CreateNotebookDialog } from "./home/CreateNotebookDialog";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./CoachSidebar.css";

const NEW_PROJECT_EVENT = "aria:new-project";

/**
 * Hosts without their own "new project" affordance (e.g. the coach shell's
 * empty state) ask the sidebar to open its create dialog through this event.
 */
export function requestNewProject() {
  window.dispatchEvent(new CustomEvent(NEW_PROJECT_EVENT));
}

export interface CoachSidebarProps {
  /** Active notebook id, supplied by the persistent route shell. */
  notebookId?: string;
  /** Which nested row of the active project is highlighted (default "coach"). */
  activeChat?: "project" | "coach" | "teach";
  /** Shared project list so the persistent sidebar and coach route stay in sync. */
  projects: NotebooksController;
  /**
   * Desktop collapse. Controlled by the host when it renders a re-open button
   * in its own header; falls back to internal state otherwise.
   */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Mobile drawer. Same controlled/uncontrolled pattern as `collapsed`. */
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
  /**
   * Bump to re-fetch the active project's guided-reading rows (a host's
   * reading dialog may have created a session).
   */
  readingsVersion?: number;
  /**
   * Called (and awaited) after the list changes — create/delete — so hosts
   * holding their own notebook list can refresh before the sidebar navigates.
   */
  onListChanged?: () => void | Promise<void>;
}

/**
 * The learning-project sidebar shared by the coach shell and the teach-back
 * view: brand + collapse, "New learning project", collapsible project groups
 * (coach chat / teach-back / guided readings), and the theme/settings/account
 * footer. Self-contained: fetches its own notebook list, owns the
 * create/delete/settings dialogs, the mobile drawer + scrim, and the desktop
 * collapse — hosts only pass which nested row is active and (optionally)
 * control collapse/drawer state so they can render the matching header
 * buttons.
 */
export function CoachSidebar({
  notebookId: id,
  activeChat = "coach",
  projects,
  collapsed: collapsedProp,
  onCollapsedChange,
  drawerOpen: drawerOpenProp,
  onDrawerOpenChange,
  readingsVersion,
  onListChanged,
}: CoachSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { notebooks, error, create, remove, rename, setArchived, refresh } = projects;
  const snackbar = useSnackbar();
  const narrow = useMediaQuery("(max-width: 900px)");

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [internalDrawerOpen, setInternalDrawerOpen] = useState(false);
  const collapsed = collapsedProp ?? internalCollapsed;
  const drawerOpen = drawerOpenProp ?? internalDrawerOpen;
  const setCollapsed = (v: boolean) => {
    if (collapsedProp === undefined) setInternalCollapsed(v);
    onCollapsedChange?.(v);
  };
  const setDrawerOpen = (v: boolean) => {
    if (drawerOpenProp === undefined) setInternalDrawerOpen(v);
    onDrawerOpenChange?.(v);
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const [renameTarget, setRenameTarget] = useState<Notebook | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [addMenuId, setAddMenuId] = useState<string | null>(null);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [addedChats, setAddedChats] = useState<Record<string, { coach?: boolean; main?: boolean }>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [readings, setReadings] = useState<Record<string, ReadingSessionSummary[]>>({});
  const [globalDue, setGlobalDue] = useState<GlobalDueTopic[]>([]);
  const readingsRequested = useRef(new Set<string>());
  const accountAnchor = useRef<HTMLButtonElement>(null);
  const addChatAnchor = useRef<HTMLButtonElement>(null);
  const projectMenuAnchor = useRef<HTMLButtonElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const email = state.phase === "signed-in" ? state.email : undefined;

  // Guided-reading rows are fetched lazily the first time a group expands and
  // cached per notebook; failures are quiet (the group just shows no rows).
  const loadReadings = useCallback((notebookId: string) => {
    if (readingsRequested.current.has(notebookId)) return;
    readingsRequested.current.add(notebookId);
    api
      .listReadings(notebookId)
      .then((res) =>
        setReadings((m) => ({ ...m, [notebookId]: res.sessions.filter((s) => s.status === "ready") })),
      )
      .catch(() => {
        /* tolerate quietly */
      });
  }, []);

  // The empty state (and any other host surface) can ask for the create dialog.
  useEffect(() => {
    const onRequest = () => setCreateOpen(true);
    window.addEventListener(NEW_PROJECT_EVENT, onRequest);
    return () => window.removeEventListener(NEW_PROJECT_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (notebooks === null) return;
    api.getGlobalDue().then(
      (result) => setGlobalDue(result.due),
      () => setGlobalDue([]),
    );
  }, [notebooks]);

  // The active project starts expanded; everything else starts collapsed.
  useEffect(() => {
    if (!id) return;
    setExpanded((m) => (m[id] ? m : { ...m, [id]: true }));
    loadReadings(id);
  }, [id, loadReadings]);

  // A host's reading dialog may have created a session — refresh the rows.
  const prevReadingsVersion = useRef(readingsVersion);
  useEffect(() => {
    if (readingsVersion === prevReadingsVersion.current) return;
    prevReadingsVersion.current = readingsVersion;
    if (!id) return;
    readingsRequested.current.delete(id);
    loadReadings(id);
  }, [readingsVersion, id, loadReadings]);

  // Any navigation (including picking a project) closes the mobile drawer.
  // setDrawerOpen is render-scoped; the pathname is the real dependency.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggleGroup = (notebookId: string) => {
    const next = !expanded[notebookId];
    if (next) loadReadings(notebookId);
    setExpanded((m) => ({ ...m, [notebookId]: next }));
  };

  const openProject = (notebookId: string) => {
    setExpanded((m) => (m[notebookId] ? m : { ...m, [notebookId]: true }));
    loadReadings(notebookId);
    navigate(`/project/${notebookId}`);
  };

  const addChat = (notebookId: string, kind: "coach" | "main") => {
    setAddedChats((current) => ({
      ...current,
      [notebookId]: { ...current[notebookId], [kind]: true },
    }));
    setExpanded((current) => ({ ...current, [notebookId]: true }));
    navigate(kind === "coach" ? `/learn/${notebookId}` : `/notebook/${notebookId}`);
  };

  const beginRename = (notebook: Notebook) => {
    setRenameTarget(notebook);
    setRenameDraft(notebook.title);
  };

  const confirmRename = async () => {
    const target = renameTarget;
    const title = renameDraft.trim();
    if (!target || !title || renaming) return;
    setRenaming(true);
    try {
      await rename(target.id, title);
      setRenameTarget(null);
      snackbar.show("Project renamed");
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't rename the project");
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await remove(target.id);
      await onListChanged?.();
      if (target.id === id) navigate("/", { replace: true });
    } catch {
      snackbar.show("Couldn't delete the project", { actionLabel: "Retry", onAction: () => void refresh() });
    }
  };

  const archiveProject = async (target: Notebook) => {
    try {
      await setArchived(target.id, true);
      setProjectMenuId(null);
      snackbar.show("Project archived");
      if (target.id === id) {
        const next = notebooks?.find((notebook) => !notebook.archivedAt && notebook.id !== target.id);
        navigate(next ? `/project/${next.id}` : "/", { replace: true });
      }
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't archive the project");
    }
  };

  const restoreProject = async (target: Notebook) => {
    try {
      await setArchived(target.id, false);
      setProjectMenuId(null);
      snackbar.show("Project restored");
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't restore the project");
    }
  };

  const activeProjects = notebooks?.filter((notebook) => !notebook.archivedAt) ?? [];
  const archivedProjects = notebooks?.filter((notebook) => notebook.archivedAt) ?? [];
  const addMenuNotebook = notebooks?.find((notebook) => notebook.id === addMenuId);
  const projectMenuNotebook = notebooks?.find((notebook) => notebook.id === projectMenuId);

  return (
    <>
      <aside
        className={`shell__sidebar${
          narrow ? (drawerOpen ? " shell__sidebar--open" : " shell__sidebar--hidden") : collapsed ? " shell__sidebar--hidden" : ""
        }`}
      >
        <div className="shell__brand">
          <Icon name="psychology" size={22} className="shell__brand-icon" />
          <span className="title-medium">Aria</span>
          {!narrow && (
            <span className="shell__brand-collapse shell__panel-mirror">
              <IconButton icon="right_panel_close" ariaLabel="Hide sidebar" onClick={() => setCollapsed(true)} />
            </span>
          )}
        </div>

        <button type="button" className="shell__new body-medium" onClick={() => setCreateOpen(true)}>
          <Icon name="add" size={20} />
          <span>New learning project</span>
        </button>

        {globalDue.length > 0 && (
          <div className="shell__due">
            <span className="shell__due-label label-medium">Worth a quick return</span>
            {globalDue.map((due) => (
              <button
                key={`${due.notebookId}:${due.topic}`}
                type="button"
                className="shell__due-chip"
                onClick={() => navigate(`/learn/${due.notebookId}`)}
                title={`${due.topic} — ${due.daysSince} days since, in ${due.notebookTitle}`}
              >
                <Icon name="history_edu" size={16} />
                <span className="shell__due-topic label-large">{due.topic}</span>
                <span className="shell__due-meta label-medium">
                  {due.daysSince}d · {due.notebookTitle}
                </span>
              </button>
            ))}
          </div>
        )}

        <nav className="shell__projects" aria-label="Learning projects">
          {notebooks === null && !error && (
            <div className="shell__projects-loading">
              <ProgressIndicator size={24} />
            </div>
          )}
          {error && <span className="shell__projects-error body-medium">{error}</span>}
          {activeProjects.length > 0 && <div className="shell__section label-medium">Projects</div>}
          {activeProjects.map((nb) => {
            const isOpen = !!expanded[nb.id];
            const isActive = nb.id === id;
            const nbReadings = readings[nb.id] ?? [];
            const hasCoach = nb.hasCoachChat || addedChats[nb.id]?.coach === true;
            const hasMain =
              (nb.type === "interview" ? nb.hasInterviewChat : nb.hasTeachBackChat) ||
              addedChats[nb.id]?.main === true;
            const canAddChat = !hasCoach || !hasMain;
            return (
              <div key={nb.id} className={`shell__group${isOpen ? " shell__group--open" : ""}`}>
                <div className={`shell__group-header${isActive ? " shell__group-header--active" : ""}`}>
                  <button
                    type="button"
                    className="shell__group-toggle"
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${nb.title}`}
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(nb.id)}
                  >
                    <span className="shell__chevron" />
                  </button>
                  <button type="button" className="shell__group-title body-medium" onClick={() => openProject(nb.id)}>
                    {nb.title}
                  </button>
                  {canAddChat && (
                    <button
                      type="button"
                      className="shell__row-action"
                      aria-label={`Add chat to ${nb.title}`}
                      title="Add chat"
                      onClick={(event) => {
                        addChatAnchor.current = event.currentTarget;
                        setProjectMenuId(null);
                        setAddMenuId(nb.id);
                      }}
                    >
                      <Icon name="add" size={18} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="shell__row-action"
                    aria-label={`More options for ${nb.title}`}
                    title="Project options"
                    onClick={(event) => {
                      projectMenuAnchor.current = event.currentTarget;
                      setAddMenuId(null);
                      setProjectMenuId(nb.id);
                    }}
                  >
                    <Icon name="more_vert" size={18} />
                  </button>
                </div>
                {isOpen && (
                  <div className="shell__group-items">
                    {hasCoach && (
                      <button
                        type="button"
                        className={`shell__item body-medium${isActive && activeChat === "coach" ? " shell__item--active" : ""}`}
                        onClick={() => navigate(`/learn/${nb.id}`)}
                      >
                        <Icon name="psychology" size={18} className="shell__item-icon" />
                        <span className="shell__item-label">Learning coach</span>
                      </button>
                    )}
                    {hasMain && (
                      <button
                        type="button"
                        className={`shell__item body-medium${isActive && activeChat === "teach" ? " shell__item--active" : ""}`}
                        onClick={() => navigate(`/notebook/${nb.id}`)}
                      >
                        <Icon name={nb.type === "interview" ? "work" : "school"} size={18} className="shell__item-icon" />
                        <span className="shell__item-label">
                          {nb.type === "interview" ? "Interview practice" : "Reverse tutor"}
                        </span>
                      </button>
                    )}
                    {nbReadings.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="shell__item body-medium"
                        onClick={() => navigate(`/learn/${nb.id}/read/${r.id}`)}
                      >
                        <Icon name="auto_stories" size={18} className="shell__item-icon" />
                        <span className="shell__item-label">{r.source}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {archivedProjects.length > 0 && (
            <div className="shell__archived">
              <button
                type="button"
                className="shell__archived-toggle label-medium"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
              >
                <span className={`shell__chevron${archivedOpen ? " shell__chevron--open" : ""}`} />
                Archived
                <span className="shell__archived-count">{archivedProjects.length}</span>
              </button>
              {archivedOpen &&
                archivedProjects.map((notebook) => (
                  <div key={notebook.id} className="shell__archived-row">
                    <span className="shell__archived-title body-medium">{notebook.title}</span>
                    <button
                      type="button"
                      className="shell__row-action"
                      aria-label={`More options for ${notebook.title}`}
                      onClick={(event) => {
                        projectMenuAnchor.current = event.currentTarget;
                        setAddMenuId(null);
                        setProjectMenuId(notebook.id);
                      }}
                    >
                      <Icon name="more_vert" size={18} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </nav>

        <footer className="shell__footer">
          <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} ariaLabel="Toggle theme" onClick={toggle} />
          <IconButton icon="settings" ariaLabel="Settings" onClick={() => setSettingsOpen(true)} />
          <button
            ref={accountAnchor}
            type="button"
            className="shell__account"
            onClick={() => setAccountOpen(true)}
            aria-label="Account"
            title={email}
          >
            <span className="shell__avatar label-large">{(email?.[0] ?? "?").toUpperCase()}</span>
          </button>
          <Menu
            open={accountOpen}
            onClose={() => setAccountOpen(false)}
            anchorRef={accountAnchor}
            header={
              email && (
                <div className="shell__account-id">
                  <span className="body-medium">{email}</span>
                  {state.phase === "signed-in" && state.planType && (
                    <span className="shell__account-plan body-medium">{state.planType} plan</span>
                  )}
                </div>
              )
            }
            items={[{ icon: "logout", label: "Sign out", onSelect: () => void logout() }]}
          />
        </footer>
      </aside>

      {narrow && drawerOpen && <div className="shell__scrim" onClick={() => setDrawerOpen(false)} />}

      <Menu
        open={addMenuId !== null}
        onClose={() => setAddMenuId(null)}
        anchorRef={addChatAnchor}
        header={<span className="label-medium">Add a chat</span>}
        items={[
          ...(!addMenuNotebook?.hasCoachChat && !addedChats[addMenuNotebook?.id ?? ""]?.coach
            ? [
                {
                  icon: "psychology" as const,
                  label: "Learning coach",
                  onSelect: () => {
                    if (addMenuId) addChat(addMenuId, "coach");
                  },
                },
              ]
            : []),
          ...(!(
            addMenuNotebook?.type === "interview"
              ? addMenuNotebook.hasInterviewChat
              : addMenuNotebook?.hasTeachBackChat
          ) && !addedChats[addMenuNotebook?.id ?? ""]?.main
            ? [
                {
                  icon: addMenuNotebook?.type === "interview" ? ("work" as const) : ("school" as const),
                  label: addMenuNotebook?.type === "interview" ? "Interview practice" : "Reverse tutor",
                  onSelect: () => {
                    if (addMenuId) addChat(addMenuId, "main");
                  },
                },
              ]
            : []),
        ]}
      />

      <Menu
        open={projectMenuId !== null}
        onClose={() => setProjectMenuId(null)}
        anchorRef={projectMenuAnchor}
        items={
          projectMenuNotebook?.archivedAt
            ? [
                {
                  icon: "unarchive",
                  label: "Restore project",
                  onSelect: () => void restoreProject(projectMenuNotebook),
                },
                {
                  icon: "delete",
                  label: "Delete project",
                  destructive: true,
                  onSelect: () => setDeleteTarget(projectMenuNotebook),
                },
              ]
            : [
                {
                  icon: "edit",
                  label: "Edit name",
                  onSelect: () => {
                    if (projectMenuNotebook) beginRename(projectMenuNotebook);
                  },
                },
                {
                  icon: "archive",
                  label: "Archive project",
                  onSelect: () => {
                    if (projectMenuNotebook) void archiveProject(projectMenuNotebook);
                  },
                },
                {
                  icon: "delete",
                  label: "Delete project",
                  destructive: true,
                  onSelect: () => {
                    if (projectMenuNotebook) setDeleteTarget(projectMenuNotebook);
                  },
                },
              ]
        }
      />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <CreateNotebookDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={create}
        onCreated={(nb) => {
          setCreateOpen(false);
          // Let hosts refresh their own list before navigating so route
          // guards keyed on the list see the new project.
          void Promise.resolve(onListChanged?.()).then(() => navigate(`/project/${nb.id}`));
        }}
      />

      <Dialog
        open={renameTarget !== null}
        onClose={() => {
          if (!renaming) setRenameTarget(null);
        }}
        headline="Rename project"
        actions={
          <>
            <Button variant="text" onClick={() => setRenameTarget(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRename()} disabled={!renameDraft.trim() || renaming}>
              Save
            </Button>
          </>
        }
        width={420}
      >
        <TextField
          label="Project name"
          value={renameDraft}
          onChange={setRenameDraft}
          onSubmit={() => void confirmRename()}
          autoFocus
        />
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        icon="delete"
        headline="Delete this project?"
        actions={
          <>
            <Button variant="text" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <span className="body-medium">
          The coach conversation, teaching sessions and sources for <strong>{deleteTarget?.title}</strong> will be
          removed.
        </span>
      </Dialog>
    </>
  );
}
