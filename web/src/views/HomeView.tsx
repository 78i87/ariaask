import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Fab } from "../components/Fab";
import { IconButton } from "../components/IconButton";
import { Menu } from "../components/Menu";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { TopAppBar } from "../components/TopAppBar";
import { useSnackbar } from "../components/Snackbar";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { useNotebooks } from "../lib/useNotebooks";
import type { Notebook } from "../lib/types";
import { CreateNotebookDialog } from "./home/CreateNotebookDialog";
import { NotebookCard } from "./home/NotebookCard";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./HomeView.css";

export function HomeView() {
  const navigate = useNavigate();
  const { state, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { notebooks, error, create, remove, refresh } = useNotebooks();
  const snackbar = useSnackbar();

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const accountAnchor = useRef<HTMLButtonElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const email = state.phase === "signed-in" ? state.email : undefined;

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await remove(target.id);
    } catch {
      snackbar.show("Couldn't delete notebook", { actionLabel: "Retry", onAction: () => void refresh() });
    }
  };

  return (
    <div className="home">
      <TopAppBar
        headline={<span className="title-large">Aria</span>}
        trailing={
          <>
            <IconButton
              icon={theme === "dark" ? "light_mode" : "dark_mode"}
              ariaLabel="Toggle theme"
              onClick={toggle}
            />
            <IconButton icon="settings" ariaLabel="Settings" onClick={() => setSettingsOpen(true)} />
            <button
              ref={accountAnchor}
              type="button"
              className="home__account"
              onClick={() => setAccountOpen(true)}
              aria-label="Account"
              title={email}
            >
              <span className="home__avatar label-large">{(email?.[0] ?? "?").toUpperCase()}</span>
            </button>
            <Menu
              open={accountOpen}
              onClose={() => setAccountOpen(false)}
              anchorRef={accountAnchor}
              header={
                email && (
                  <div className="home__account-id">
                    <span className="body-medium">{email}</span>
                    {state.phase === "signed-in" && state.planType && (
                      <span className="home__account-plan body-medium">{state.planType} plan</span>
                    )}
                  </div>
                )
              }
              items={[{ icon: "logout", label: "Sign out", onSelect: () => void logout() }]}
            />
          </>
        }
      />

      <main className="home__content">
        <div className="home__hero">
          <h1 className="expressive-headline">
            What will you <span className="home__hero-accent">teach</span> today?
          </h1>
          <Fab icon="add" label="New notebook" onClick={() => setCreateOpen(true)} className="home__fab" />
        </div>

        {notebooks === null && !error && (
          <div className="home__loading">
            <ProgressIndicator />
          </div>
        )}

        {error && (
          <EmptyState
            icon="cloud_off"
            headline="Couldn't load notebooks"
            body={error}
            action={<Button onClick={() => void refresh()}>Retry</Button>}
          />
        )}

        {notebooks?.length === 0 && (
          <EmptyState
            icon="school"
            headline="Teach your first lesson"
            body="Create a notebook from a topic or your own notes — your student is waiting."
            action={
              <Button icon="add" onClick={() => setCreateOpen(true)}>
                New notebook
              </Button>
            }
          />
        )}

        {notebooks && notebooks.length > 0 && (
          <div className="home__grid">
            {notebooks.map((nb, i) => (
              <NotebookCard
                key={nb.id}
                notebook={nb}
                index={i}
                onOpen={() => navigate(`/notebook/${nb.id}`)}
                onDelete={() => setDeleteTarget(nb)}
              />
            ))}
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
          navigate(`/notebook/${nb.id}`);
        }}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        icon="delete"
        headline="Delete notebook?"
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
          Sessions and sources for <strong>{deleteTarget?.title}</strong> will be removed.
        </span>
      </Dialog>
    </div>
  );
}
