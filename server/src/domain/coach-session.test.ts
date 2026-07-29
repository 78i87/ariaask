import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient } from "../appserver/client.js";
import { CoachSessionManager, renderCoachSourceNotesBlock } from "./coach-session.js";
import type { CoachMessage } from "./store.js";

test("coach kickoff persists only the final agent message", async () => {
  const notebook = {
    id: "notebook-1",
    coach: {
      messages: [] as CoachMessage[],
      kickoffDone: false,
      updatedAt: new Date(0).toISOString(),
    },
  };
  const manager = new CoachSessionManager(
    new AppServerClient("/unused"),
    {
      get: (id: string) => (id === notebook.id ? notebook : undefined),
      save: async () => {},
    } as never,
    {} as never,
    {} as never,
  );
  const internals = manager as unknown as {
    ensureSession: (notebookId: string) => {
      state: "idle" | "streaming";
      turnId: string | null;
      kickoffTurn: boolean;
      responseMessages: { id: string; text: string }[];
      partials: Map<string, string>;
      finalizedItems: Set<string>;
    };
    onThreadNotification: (session: unknown, method: string, params: unknown) => void;
    onTurnCompleted: (session: unknown, params: unknown) => Promise<void>;
  };
  const session = internals.ensureSession(notebook.id);
  session.state = "streaming";
  session.turnId = "turn-1";
  session.kickoffTurn = true;

  internals.onThreadNotification(session, "item/completed", {
    turnId: "turn-1",
    item: {
      id: "preamble",
      type: "agentMessage",
      text: "I'll inspect the material first.",
    },
  });
  internals.onThreadNotification(session, "item/completed", {
    turnId: "turn-1",
    item: {
      id: "greeting",
      type: "agentMessage",
      text: "Welcome — let's choose the first learning step.",
    },
  });
  internals.onThreadNotification(session, "item/started", {
    turnId: "stale-turn",
    item: { id: "stale-command", type: "commandExecution" },
  });
  await internals.onTurnCompleted(session, {
    turn: {
      id: "turn-1",
      status: "completed",
    },
  });

  assert.deepEqual(notebook.coach.messages, [
    {
      id: "greeting",
      role: "coach",
      text: "Welcome — let's choose the first learning step.",
      turnId: "turn-1",
      createdAt: notebook.coach.messages[0]?.createdAt,
    },
  ]);
  assert.equal(notebook.coach.kickoffDone, true);
  assert.deepEqual(session.responseMessages, []);
  assert.equal(session.state, "idle");
});

test("coach tool preambles are discarded while a real stopped response is preserved", async () => {
  const messages: CoachMessage[] = [];
  const notebook = {
    id: "notebook-2",
    coach: {
      messages,
      kickoffDone: true,
      updatedAt: new Date(0).toISOString(),
    },
  };
  const manager = new CoachSessionManager(
    new AppServerClient("/unused"),
    {
      get: (id: string) => (id === notebook.id ? notebook : undefined),
      save: async () => {},
    } as never,
    {} as never,
    {} as never,
  );
  const internals = manager as unknown as {
    ensureSession: (notebookId: string) => {
      state: "idle" | "streaming";
      turnId: string | null;
      kickoffTurn: boolean;
      responseMessages: { id: string; text: string }[];
      partials: Map<string, string>;
      finalizedItems: Set<string>;
    };
    onThreadNotification: (session: unknown, method: string, params: unknown) => void;
    onTurnCompleted: (session: unknown, params: unknown) => Promise<void>;
  };
  const session = internals.ensureSession(notebook.id);
  session.state = "streaming";
  session.turnId = "turn-preamble";
  session.kickoffTurn = false;

  internals.onThreadNotification(session, "item/completed", {
    turnId: "turn-preamble",
    item: {
      id: "preamble",
      type: "agentMessage",
      text: "I'll inspect the material first.",
    },
  });
  internals.onThreadNotification(session, "item/started", {
    turnId: "turn-preamble",
    item: { id: "command", type: "commandExecution" },
  });
  await internals.onTurnCompleted(session, {
    turn: { id: "turn-preamble", status: "interrupted" },
  });
  assert.equal(messages.length, 0);

  session.state = "streaming";
  session.turnId = "turn-partial";
  session.kickoffTurn = false;
  internals.onThreadNotification(session, "item/agentMessage/delta", {
    turnId: "turn-partial",
    itemId: "answer",
    delta: "A useful answer in progress.",
  });
  await internals.onTurnCompleted(session, {
    turn: { id: "turn-partial", status: "interrupted" },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text, "A useful answer in progress.");
  assert.equal(messages[0]?.interrupted, true);
});

test("coach source notes distinguish additions, removals, and legacy additions", () => {
  const block = renderCoachSourceNotesBlock([
    "legacy-notes.md",
    { kind: "added", name: "new-paper.pdf" },
    { kind: "removed", name: "outdated-guide.md" },
  ]);

  assert.match(block, /added new study material: legacy-notes\.md, new-paper\.pdf/);
  assert.match(block, /removed study material: outdated-guide\.md/);
  assert.match(block, /do not cite or rely on it/);
});
