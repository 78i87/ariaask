import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NotebookStore, toSummary } from "./store.js";

test("archivedAt stays backward compatible and persists through summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const notebook = await store.create({ title: "Interest", goal: "Interest" });
    assert.equal(toSummary(notebook).archivedAt, null);
    notebook.archivedAt = "2026-07-11T00:00:00.000Z";
    await store.save(notebook);

    const reloaded = new NotebookStore(dir);
    await reloaded.init();
    assert.equal(reloaded.list()[0]?.archivedAt, "2026-07-11T00:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("renaming a project preserves its immutable prompt goal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-goal-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const notebook = await store.create({
      title: "Distributed systems",
      goal: "Learn how consensus protocols handle failure",
    });
    notebook.title = "Systems interview prep";
    await store.save(notebook);

    const reloaded = new NotebookStore(dir);
    await reloaded.init();
    const summary = reloaded.list()[0];
    assert.equal(summary?.title, "Systems interview prep");
    assert.equal(summary?.goal, "Learn how consensus protocols handle failure");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("multiple activity metadata and archive state survive persistence and summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-interview-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const notebook = await store.create({ title: "Frontend practice", goal: "Prepare for frontend interviews" });
    await store.createActivity(notebook.id, { kind: "coach" });
    await store.createActivity(notebook.id, { kind: "coach" });
    await store.createActivity(notebook.id, {
      kind: "interview",
      interview: { role: "Senior Frontend Engineer", company: "Meridian Labs" },
      cvSource: "cv.txt",
    });
    notebook.archivedAt = "2026-07-11T00:00:00.000Z";
    await store.save(notebook);

    const reloaded = new NotebookStore(dir);
    await reloaded.init();
    const summary = reloaded.list()[0];
    assert.equal(summary?.activities[0]?.title, "Learning coach");
    assert.equal(summary?.activities[1]?.title, "Learning coach 2");
    assert.deepEqual(summary?.activities[2]?.interview, {
      role: "Senior Frontend Engineer",
      company: "Meridian Labs",
    });
    assert.equal(summary?.archivedAt, "2026-07-11T00:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("activity session facades isolate transcripts while sharing project knowledge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-activities-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const project = await store.create({ title: "Databases", goal: "Learn database internals" });
    const first = await store.createActivity(project.id, { kind: "reverse-tutor" });
    const second = await store.createActivity(project.id, { kind: "reverse-tutor" });
    const firstView = store.getSession(store.activityKey(project.id, first.id))!;
    const secondView = store.getSession(store.activityKey(project.id, second.id))!;

    firstView.messages.push({
      id: "m1",
      role: "teacher",
      text: "A B-tree keeps keys ordered.",
      turnId: null,
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    firstView.userKnowledgeState = {
      version: 1,
      beliefs: [],
      lastChanges: [],
      lastEvaluatedMessageId: "m1",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    await store.save(firstView);

    assert.equal(secondView.messages.length, 0);
    assert.equal(secondView.userKnowledgeState?.lastEvaluatedMessageId, "m1");
    assert.equal(project.activities[0]?.kind, "reverse-tutor");
    assert.equal(project.activities[0]?.messages.length, 1);
    assert.equal(project.activities[1]?.kind, "reverse-tutor");
    assert.equal(project.activities[1]?.messages.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("interview source bindings are activity-local and become incomplete when the CV is removed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-source-bindings-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const project = await store.create({ title: "Career", goal: "Prepare for interviews" });
    project.sourceFiles.push(
      {
        originalName: "Morgan CV",
        storedName: "cv.txt",
        extractedName: null,
        mimeType: "text/plain",
        size: 10,
        approxWords: 2,
      },
      {
        originalName: "Role",
        storedName: "role.txt",
        extractedName: null,
        mimeType: "text/plain",
        size: 10,
        approxWords: 2,
      },
    );
    const interview = await store.createActivity(project.id, {
      kind: "interview",
      interview: { role: "Engineer", company: null },
      cvSource: "cv.txt",
      jobDescriptionSource: "role.txt",
    });
    const view = store.getSession(store.activityKey(project.id, interview.id))!;
    assert.equal(view.sourceFiles.find((source) => source.storedName === "cv.txt")?.kind, "cv");
    assert.equal(view.sourceFiles.find((source) => source.storedName === "role.txt")?.kind, "jd");

    store.queueSourceRemoval(project, project.sourceFiles[0]!);
    assert.equal(interview.kind, "interview");
    assert.equal(interview.kind === "interview" ? interview.cvSource : "wrong", null);
    assert.equal(toSummary(project).activities[0]?.setupComplete, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
