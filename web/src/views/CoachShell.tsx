import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { Menu } from "../components/Menu";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useSnackbar } from "../components/Snackbar";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useNotebooks } from "../lib/useNotebooks";
import { useTheme } from "../lib/theme";
import type { Notebook } from "../lib/types";
import { CoachChatView } from "./coach/CoachChatView";
import { CreateNotebookDialog } from "./home/CreateNotebookDialog";
import { AddSourcesDialog } from "./session/AddSourcesDialog";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./CoachShell.css";

/**
 * The app's front door: a chatbot-style shell with the learning projects in a
 * left sidebar and the selected project's coach conversation as the main
 * pane. Teach-back (the Aria student, /notebook/:id) is one technique the
 * coach can recommend — launched from the header, returning here after.
 */
export function CoachShell() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { state, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { notebooks, error, create, remove, refresh } = useNotebooks();
  const snackbar = useSnackbar();
  const narrow = useMediaQuery("(max-width: 900px)");

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const accountAnchor = useRef<HTMLButtonElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const email = state.phase === "signed-in" ? state.email : undefined;
  const current = useMemo(() => notebooks?.find((n) => n.id === id) ?? null, [notebooks, id]);

  // "/" (or a stale id) lands on the most recent project once the list loads.
  useEffect(() => {
    if (notebooks === null) return;
    if ((!id || !notebooks.some((n) => n.id === id)) && notebooks.length > 0) {
      navigate(`/learn/${notebooks[0]!.id}`, { replace: true });
    }
  }, [id, notebooks, navigate]);

  useEffect(() => setDrawerOpen(false), [id]); // picking a project closes the mobile drawer

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await remove(target.id);
      if (target.id === id) navigate("/", { replace: true });
    } catch {
      snackbar.show("Couldn't delete the project", { actionLabel: "Retry", onAction: () => void refresh() });
    }
  };

  const sidebar = (
    <aside className={`shell__sidebar${narrow ? (drawerOpen ? " shell__sidebar--open" : " shell__sidebar--hidden") : ""}`}>
      <div className="shell__brand">
        <Icon name="psychology" size={22} className="shell__brand-icon" />
        <span className="title-medium">Aria</span>
        <span className="shell__brand-sub label-medium">learning coach</span>
      </div>

      <div className="shell__new">
        <Button icon="add" onClick={() => setCreateOpen(true)}>
          New learning project
        </Button>
      </div>

      <nav className="shell__projects" aria-label="Learning projects">
        {notebooks === null && !error && (
          <div className="shell__projects-loading">
            <ProgressIndicator size={24} />
          </div>
        )}
        {error && <span className="shell__projects-error body-medium">{error}</span>}
        {notebooks?.map((nb) => (
          <div key={nb.id} className={`shell__project${nb.id === id ? " shell__project--active" : ""}`}>
            <button type="button" className="shell__project-open" onClick={() => navigate(`/learn/${nb.id}`)}>
              <span className="shell__project-title body-large">{nb.title}</span>
            </button>
            <span className="shell__project-delete">
              <IconButton icon="delete" ariaLabel={`Delete ${nb.title}`} onClick={() => setDeleteTarget(nb)} />
            </span>
          </div>
        ))}
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
  );

  return (
    <div className="shell">
      {sidebar}
      {narrow && drawerOpen && <div className="shell__scrim" onClick={() => setDrawerOpen(false)} />}

      <main className="shell__main">
        {current ? (
          <>
            <header className="shell__header">
              {narrow && <IconButton icon="menu" ariaLabel="Projects" onClick={() => setDrawerOpen(true)} />}
              <h1 className="shell__title title-medium">{current.title}</h1>
              <div className="shell__header-actions">
                <button type="button" className="shell__chip label-large" onClick={() => setSourcesOpen(true)}>
                  <Icon name="library_books" size={18} />
                  <span className="shell__chip-label">Sources</span>
                  {current.sourceFiles.length > 0 && <span className="shell__chip-count">{current.sourceFiles.length}</span>}
                </button>
                <button
                  type="button"
                  className="shell__chip shell__chip--teach label-large"
                  onClick={() => navigate(`/notebook/${current.id}`)}
                >
                  <Icon name="school" size={18} />
                  <span className="shell__chip-label">Teach it back</span>
                </button>
              </div>
            </header>
            <CoachChatView notebookId={current.id} />
          </>
        ) : notebooks === null ? (
          <div className="shell__empty">
            <ProgressIndicator />
          </div>
        ) : (
          <div className="shell__empty">
            {narrow && (
              <div className="shell__empty-menu">
                <IconButton icon="menu" ariaLabel="Projects" onClick={() => setDrawerOpen(true)} />
              </div>
            )}
            <EmptyState
              icon="psychology"
              headline="What do you want to learn?"
              body="Your coach helps you learn anything — the right technique for the right task, at the right stage."
              action={
                <Button icon="add" onClick={() => setCreateOpen(true)}>
                  New learning project
                </Button>
              }
            />
          </div>
        )}
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <CreateNotebookDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={create}
        onCreated={(nb) => {
          setCreateOpen(false);
          navigate(`/learn/${nb.id}`);
        }}
        coachFirst
      />

      {current && (
        <AddSourcesDialog
          open={sourcesOpen}
          notebookId={current.id}
          topicSuggestion={current.topic ?? current.title}
          discovering={false}
          kickoffRunning={false}
          intakePending={false}
          onClose={() => setSourcesOpen(false)}
          onAdded={() => void refresh()}
          onDiscover={(query) => {
            void api.discoverSources(current.id, { query }).catch((err) => {
              snackbar.show(err instanceof Error ? err.message : "Couldn't start the search");
            });
          }}
        />
      )}

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
    </div>
  );
}
