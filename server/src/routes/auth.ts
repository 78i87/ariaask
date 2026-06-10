import { Router } from "express";
import type { AppServerClient } from "../appserver/client.js";
import type { AccountLoginCompletedNotification } from "../appserver/protocol.js";
import { HttpError } from "../lib/errors.js";

const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** Keep a settled login readable by the poller briefly, then drop it so the map can't grow unbounded. */
const SETTLE_TTL_MS = 60_000;

interface LoginState {
  status: "pending" | "success" | "failed";
  error?: string;
  timer: NodeJS.Timeout;
}

export class LoginTracker {
  private states = new Map<string, LoginState>();

  constructor(private client: AppServerClient) {
    client.on("login-completed", (n: AccountLoginCompletedNotification) => {
      if (n.loginId) {
        const state = this.states.get(n.loginId);
        if (state) this.settle(n.loginId, state, n.success, n.error);
      } else {
        // No loginId: only safe to attribute when exactly one login is pending.
        const pending = [...this.states.entries()].filter(([, s]) => s.status === "pending");
        if (pending.length === 1) {
          const [loginId, state] = pending[0]!;
          this.settle(loginId, state, n.success, n.error);
        }
      }
    });
  }

  private settle(loginId: string, state: LoginState, success: boolean, error: string | null): void {
    clearTimeout(state.timer);
    state.status = success ? "success" : "failed";
    if (error) state.error = error;
    setTimeout(() => this.states.delete(loginId), SETTLE_TTL_MS);
  }

  track(loginId: string): void {
    const timer = setTimeout(() => {
      const state = this.states.get(loginId);
      if (state && state.status === "pending") {
        state.error = "login_timeout";
        void this.client.loginCancel(loginId).catch(() => {});
        this.settle(loginId, state, false, "login_timeout");
      }
    }, LOGIN_TIMEOUT_MS);
    this.states.set(loginId, { status: "pending", timer });
  }

  get(loginId: string): LoginState | undefined {
    return this.states.get(loginId);
  }

  cancel(loginId: string): void {
    const state = this.states.get(loginId);
    if (state) this.settle(loginId, state, false, "cancelled");
  }
}

export function authRoutes(client: AppServerClient, logins: LoginTracker): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const account = await client.readAccount();
    if (account.account?.type === "chatgpt") {
      res.json({ authenticated: true, email: account.account.email, planType: account.account.planType });
    } else if (account.account) {
      res.json({ authenticated: true });
    } else {
      res.json({ authenticated: false });
    }
  });

  router.post("/login", async (_req, res) => {
    const result = await client.loginStart();
    logins.track(result.loginId);
    res.json({ loginId: result.loginId, authUrl: result.authUrl });
  });

  router.get("/login/:loginId", (req, res) => {
    const state = logins.get(req.params.loginId);
    if (!state) throw new HttpError(404, "login_not_found");
    res.json({ status: state.status, error: state.error });
  });

  router.delete("/login/:loginId", async (req, res) => {
    logins.cancel(req.params.loginId);
    await client.loginCancel(req.params.loginId).catch(() => {});
    res.status(204).end();
  });

  router.post("/logout", async (_req, res) => {
    await client.logout();
    res.status(204).end();
  });

  return router;
}
