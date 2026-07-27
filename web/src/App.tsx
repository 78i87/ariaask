import { Navigate, Route, Routes } from "react-router-dom";
import { Button } from "./components/Button";
import { EmptyState } from "./components/EmptyState";
import { ProgressIndicator } from "./components/ProgressIndicator";
import { SnackbarProvider } from "./components/Snackbar";
import { AuthProvider, useAuth } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { CoachShell } from "./views/CoachShell";
import { LearningShell } from "./views/LearningShell";
import { ProjectView } from "./views/ProjectView";
import { ReadingView } from "./views/reading/ReadingView";
import { SessionView } from "./views/SessionView";
import { SignInView } from "./views/SignInView";

function Gate() {
  const { state, refresh } = useAuth();

  if (state.phase === "checking") {
    return (
      <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <ProgressIndicator />
      </div>
    );
  }

  if (state.phase === "backend-down") {
    return (
      <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <EmptyState
          icon="cloud_off"
          headline="Can't reach Aria's backend"
          body={state.detail ?? "Make sure the Aria server is running (npm run dev), then try again."}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      </div>
    );
  }

  if (state.phase === "signed-out" || state.phase === "waiting-oauth") {
    return <SignInView />;
  }

  return (
    <Routes>
      <Route element={<LearningShell />}>
        <Route index element={<ProjectView />} />
        <Route path="/project/:id" element={<ProjectView />} />
        <Route path="/learn/:id" element={<CoachShell />} />
        <Route path="/notebook/:id" element={<SessionView />} />
      </Route>
      <Route path="/learn/:id/read/:rid" element={<ReadingView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <SnackbarProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </SnackbarProvider>
    </ThemeProvider>
  );
}
