import { createContext, useContext, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useNotebooks, type NotebooksController } from "../lib/useNotebooks";
import { CoachSidebar } from "./CoachSidebar";
import "./LearningShell.css";

interface LearningShellState {
  narrow: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  refreshSidebarReadings: () => void;
  projects: NotebooksController;
}

const LearningShellContext = createContext<LearningShellState | null>(null);

export function useLearningShell(): LearningShellState {
  const value = useContext(LearningShellContext);
  if (!value) throw new Error("useLearningShell must be used inside LearningShell");
  return value;
}

/**
 * Persistent navigation frame for the coach and teach-back chats. Keeping the
 * sidebar above the route outlet means switching chats swaps only the main
 * pane; the project list and its expanded rows never unmount and flash.
 */
export function LearningShell() {
  const location = useLocation();
  const projectMatch = useMatch("/project/:id");
  const coachMatch = useMatch("/learn/:id");
  const teachMatch = useMatch("/notebook/:id");
  const notebookId = projectMatch?.params.id ?? coachMatch?.params.id ?? teachMatch?.params.id;
  const activeChat = location.pathname.startsWith("/project/")
    ? "project"
    : location.pathname.startsWith("/notebook/")
      ? "teach"
      : "coach";
  const narrow = useMediaQuery("(max-width: 900px)");
  const projects = useNotebooks();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readingsVersion, setReadingsVersion] = useState(0);

  const context = useMemo<LearningShellState>(
    () => ({
      narrow,
      sidebarCollapsed,
      setSidebarCollapsed,
      drawerOpen,
      setDrawerOpen,
      refreshSidebarReadings: () => setReadingsVersion((version) => version + 1),
      projects,
    }),
    [narrow, sidebarCollapsed, drawerOpen, projects],
  );

  return (
    <LearningShellContext.Provider value={context}>
      <div className="learning-shell">
        <CoachSidebar
          notebookId={notebookId}
          activeChat={activeChat}
          projects={projects}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          drawerOpen={drawerOpen}
          onDrawerOpenChange={setDrawerOpen}
          readingsVersion={readingsVersion}
          onListChanged={projects.refresh}
        />
        <Outlet />
      </div>
    </LearningShellContext.Provider>
  );
}
