import { Navigate, Route, Routes } from "react-router-dom";
import { Button } from "./components/Button";
import { EmptyState } from "./components/EmptyState";
import { ProgressIndicator } from "./components/ProgressIndicator";
import { SnackbarProvider } from "./components/Snackbar";
import { AuthProvider, useAuth } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { HomeView } from "./views/HomeView";
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
      <Route path="/" element={<HomeView />} />
      <Route path="/notebook/:id" element={<SessionView />} />
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
