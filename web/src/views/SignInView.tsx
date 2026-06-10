import { useState } from "react";
import { Button } from "../components/Button";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { useAuth } from "../lib/auth";
import { useSnackbar } from "../components/Snackbar";
import "./SignInView.css";

export function SignInView() {
  const { state, login, cancelLogin } = useAuth();
  const snackbar = useSnackbar();
  const [starting, setStarting] = useState(false);
  const waiting = state.phase === "waiting-oauth";

  const onSignIn = async () => {
    setStarting(true);
    try {
      await login();
    } catch (err) {
      snackbar.show(err instanceof Error && err.message ? err.message : "Couldn't start sign-in.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin__blob signin__blob--primary" />
      <div className="signin__blob signin__blob--tertiary" />
      <div className="signin__stack">
        <h1 className="signin__wordmark display-large">Aria</h1>
        <p className="signin__tagline title-large">Learn anything by teaching it.</p>
        <div className="signin__spacer" />
        {waiting ? (
          <div className="signin__waiting">
            <ProgressIndicator size={32} />
            <span className="body-medium">Complete sign-in in your browser…</span>
            <Button variant="text" onClick={cancelLogin}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button icon="login" onClick={() => void onSignIn()} disabled={starting}>
            Sign in with OpenAI
          </Button>
        )}
      </div>
    </div>
  );
}
