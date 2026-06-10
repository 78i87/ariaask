import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { AuthStatus } from "./types";

type AuthState =
  | { phase: "checking" }
  | { phase: "backend-down"; detail?: string }
  | { phase: "signed-out" }
  | { phase: "waiting-oauth" }
  | { phase: "signed-in"; email?: string; planType?: string };

interface AuthApi {
  state: AuthState;
  refresh: () => Promise<void>;
  login: () => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: "checking" });
  const pollRef = useRef<number | null>(null);
  const loginIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyStatus = useCallback((status: AuthStatus) => {
    setState(
      status.authenticated
        ? { phase: "signed-in", email: status.email, planType: status.planType }
        : { phase: "signed-out" },
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyStatus(await api.authStatus());
    } catch (err) {
      // A network failure OR a 5xx (dead proxy target, codex missing, app-server
      // starting) means the backend isn't usable — that's not "signed out".
      if (err instanceof ApiError && (err.kind === "network" || (err.status !== undefined && err.status >= 500))) {
        setState({ phase: "backend-down", detail: err.kind === "http" ? err.message : undefined });
      } else {
        setState({ phase: "signed-out" });
      }
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    return stopPolling;
  }, [refresh, stopPolling]);

  const login = useCallback(async () => {
    const { loginId, authUrl } = await api.loginStart();
    loginIdRef.current = loginId;
    window.open(authUrl, "_blank", "noopener");
    setState({ phase: "waiting-oauth" });
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const poll = await api.loginPoll(loginId);
        if (poll.status === "success") {
          stopPolling();
          await refresh();
        } else if (poll.status === "failed") {
          stopPolling();
          setState({ phase: "signed-out" });
        }
      } catch {
        /* keep polling; transient */
      }
    }, 1500);
  }, [refresh, stopPolling]);

  const cancelLogin = useCallback(() => {
    stopPolling();
    if (loginIdRef.current) void api.loginCancel(loginIdRef.current).catch(() => {});
    setState({ phase: "signed-out" });
  }, [stopPolling]);

  const logout = useCallback(async () => {
    await api.logout();
    setState({ phase: "signed-out" });
  }, []);

  return <AuthContext.Provider value={{ state, refresh, login, cancelLogin, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
