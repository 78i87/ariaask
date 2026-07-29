import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient } from "../appserver/client.js";
import { SessionManager } from "./session.js";

test("intentional restart aborts every pre-stream branch before the main session becomes idle", async () => {
  const client = new AppServerClient("/unused");
  const manager = new SessionManager(
    client,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
  );
  const session = (
    manager as unknown as {
      ensureSession: (notebookId: string) => {
        state: "idle" | "starting";
        cancelRequested: boolean;
        startAbort: AbortController | null;
        researchAbort: AbortController | null;
      };
    }
  ).ensureSession("notebook-1");
  const startAbort = new AbortController();
  const researchAbort = new AbortController();
  session.state = "starting";
  session.startAbort = startAbort;
  session.researchAbort = researchAbort;

  client.emit("restarting");

  assert.equal(session.cancelRequested, true);
  assert.equal(startAbort.signal.aborted, true);
  assert.equal(researchAbort.signal.aborted, true);
  assert.equal(session.startAbort, null);
  assert.equal(session.researchAbort, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.state, "idle");
});

test("project discovery lifecycle reaches initialized activity sessions", () => {
  const project = {
    id: "project-1",
    title: "Systems",
    goal: "Learn distributed systems",
    sourceFiles: [],
    activities: [{ id: "activity-1" }],
  };
  const activityKey = `${project.id}:activity-1`;
  const store = {
    get: (id: string) => (id === project.id ? project : undefined),
    getSession: (id: string) => (id === project.id || id === activityKey ? project : undefined),
    activityKey: (projectId: string, activityId: string) => `${projectId}:${activityId}`,
    parseActivityKey: (key: string) => (key === activityKey ? { projectId: project.id, activityId: "activity-1" } : null),
  };
  const manager = new SessionManager(new AppServerClient("/unused"), store as never, {} as never, {} as never);
  const internals = manager as unknown as {
    discoveries: Map<string, AbortController>;
    ensureSession: (notebookId: string) => {
      clients: Set<{ send: (event: string, data: unknown) => void }>;
    };
    broadcastProjectState: (projectId: string) => void;
    broadcastProjectEvent: (projectId: string, event: string, data: unknown) => void;
  };
  const projectEvents: Array<{ event: string; data: unknown }> = [];
  const activityEvents: Array<{ event: string; data: unknown }> = [];
  internals.ensureSession(project.id).clients.add({
    send: (event, data) => projectEvents.push({ event, data }),
  });
  internals.ensureSession(activityKey).clients.add({
    send: (event, data) => activityEvents.push({ event, data }),
  });
  internals.discoveries.set(project.id, new AbortController());

  internals.broadcastProjectState(project.id);
  internals.broadcastProjectEvent(project.id, "discover-completed", { added: [] });

  assert.equal(
    activityEvents.some(
      ({ event, data }) => event === "state" && (data as { discoveryRunning?: boolean }).discoveryRunning === true,
    ),
    true,
  );
  assert.equal(activityEvents.some(({ event }) => event === "discover-completed"), true);
  assert.equal(projectEvents.some(({ event }) => event === "discover-completed"), true);
});
