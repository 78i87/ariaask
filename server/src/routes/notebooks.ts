import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import multer from "multer";
import { HttpError } from "../lib/errors.js";
import type { LearningLogEntry, NotebookStore, SourceFile } from "../domain/store.js";
import { ensureCoachState, sanitizeName, toCyraThreadSummary, toSummary } from "../domain/store.js";
import { SESSION_GAP_MS, computeDueTopics } from "../domain/journey.js";
import type { SessionManager } from "../domain/session.js";
import type { CyraSessionManager } from "../domain/cyra-session.js";
import type { CoachSessionManager } from "../domain/coach-session.js";
import type { AppServerClient } from "../appserver/client.js";
import { approxWordCount, extractPdfText } from "../domain/extract.js";
import { createReadingSession, isGenerationOrphaned } from "../domain/reading.js";
import { awaitLinkIngestion, ingestLinks, parseLinks } from "../domain/links.js";
import { toReadingSummary, type ReadingLevel } from "../domain/store.js";
import type { UsageStore } from "../domain/usage.js";
import { composeIntakeQuestions, type IntakeAnswers, type IntakeLevel } from "../domain/intake.js";
import { dropRagIndex, ensureRagIndex } from "../domain/rag.js";
import type { SettingsStore } from "../domain/settings.js";
import { config } from "../config.js";

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".pdf"]);
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

interface UploadRequest extends Request {
  notebookId?: string;
  usedNames?: Set<string>;
}

/** Per-file processing shared by notebook creation and add-sources: PDF extraction + word counts. */
async function processUploads(
  store: NotebookStore,
  id: string,
  files: Express.Multer.File[],
  usedNames: Set<string>,
): Promise<{ sourceFiles: SourceFile[]; warnings: string[] }> {
  const warnings: string[] = [];
  const sourceFiles: SourceFile[] = [];
  for (const f of files) {
    const ext = path.extname(f.filename).toLowerCase();
    let extractedName: string | null = null;
    let approxWords: number | null = null;
    if (ext === ".pdf") {
      const text = await extractPdfText(f.path);
      if (text) {
        // Reserve the extracted name against uploads too — an uploaded
        // "lecture.extracted.txt" must not be overwritten by extraction.
        const stem = path.basename(f.filename, ext);
        let name = `${stem}.extracted.txt`;
        let n = 1;
        while (usedNames.has(name)) name = `${stem}.extracted-${n++}.txt`;
        usedNames.add(name);
        extractedName = name;
        await fs.writeFile(path.join(store.sourcesDir(id), extractedName), text, "utf8");
        approxWords = approxWordCount(text);
      } else {
        warnings.push(`"${f.originalname}" appears to be a scanned or unreadable PDF; the student may not be able to read it.`);
      }
    } else {
      const text = await fs.readFile(f.path, "utf8").catch(() => "");
      approxWords = approxWordCount(text);
    }
    sourceFiles.push({
      originalName: f.originalname,
      storedName: f.filename,
      extractedName,
      mimeType: f.mimetype,
      size: f.size,
      approxWords,
    });
  }
  return { sourceFiles, warnings };
}

export function notebookRoutes(
  store: NotebookStore,
  sessions: SessionManager,
  settings: SettingsStore,
  cyra: CyraSessionManager,
  coach: CoachSessionManager,
  client: AppServerClient,
  usage: UsageStore,
): Router {
  const router = Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req: UploadRequest, _file, cb) => cb(null, store.sourcesDir(req.notebookId!)),
      filename: (req: UploadRequest, file, cb) => cb(null, sanitizeName(file.originalname, req.usedNames!)),
    }),
    limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) cb(null, true);
      else cb(new HttpError(400, "unsupported_file_type", `Only txt, md and pdf files are supported (got ${ext || "no extension"})`));
    },
  });

  router.get("/", (_req, res) => {
    res.json({ notebooks: store.list() });
  });

  const uploadFiles = upload.array("files", MAX_FILES);

  router.post(
    "/",
    async (req: UploadRequest, _res, next) => {
      req.notebookId = randomUUID();
      req.usedNames = new Set();
      try {
        await store.prepareDir(req.notebookId);
        next();
      } catch (err) {
        next(err);
      }
    },
    // Run multer and, on any upload error, clean up the prepared dir and map
    // multer's limit errors to a clean 4xx instead of leaking a 500 + orphan dir.
    (req: UploadRequest, res, next) => {
      uploadFiles(req, res, (err: unknown) => {
        if (!err) return next();
        void fs.rm(store.notebookDir(req.notebookId!), { recursive: true, force: true }).catch(() => {});
        if (err instanceof multer.MulterError) {
          const message =
            err.code === "LIMIT_FILE_SIZE"
              ? "Each file must be under 25MB"
              : err.code === "LIMIT_FILE_COUNT"
                ? "You can upload at most 10 files"
                : err.message;
          next(new HttpError(400, "upload_rejected", message));
        } else {
          next(err);
        }
      });
    },
    async (req: UploadRequest, res) => {
      const id = req.notebookId!;
      const body = req.body as Record<string, string | undefined>;
      const type = body.type === "files" ? "files" : body.type === "topic" ? "topic" : null;
      const topic = body.topic?.trim() || null;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];

      const fail = async (status: number, code: string, message?: string) => {
        await fs.rm(store.notebookDir(id), { recursive: true, force: true });
        throw new HttpError(status, code, message);
      };

      if (!type) await fail(400, "invalid_type", 'type must be "topic" or "files"');
      if (type === "topic" && !topic) await fail(400, "missing_topic", "A topic is required");
      if (type === "files" && files.length === 0) await fail(400, "missing_files", "At least one source file is required");

      const { sourceFiles, warnings } = await processUploads(store, id, files, req.usedNames!);

      const title =
        body.title?.trim() ||
        (type === "topic" ? topic! : path.basename(files[0]!.originalname, path.extname(files[0]!.originalname)));

      const nb = await store.create({ title, type: type as "topic" | "files", topic }, id);
      nb.sourceFiles = sourceFiles;
      if (body.coachFirst === "1") {
        // Coach-shell creation: the coach conversation is the front door and
        // Aria intake init is DEFERRED to the first teach-back open (GET /:id)
        // so a project that never launches teach-back never spends a one-shot
        // call generating intake questions.
        nb.createdVia = "coach";
        ensureCoachState(nb);
        const clip = (s: string | undefined) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 300) : undefined);
        const goal = clip(body.goal);
        const current = clip(body.current);
        const deadline = clip(body.deadline);
        if (goal || current || deadline) nb.coachIntake = { goal, current, deadline };
      } else if (!config.intakeDisabled) {
        nb.intake = { status: "pending", generatedQuestions: null, answers: null, research: "none", submittedAt: null };
      }
      await store.save(nb);
      // Head start: generate the model-authored setup questions while the
      // user's browser navigates to the session.
      if (nb.intake) void sessions.ensureIntakeQuestions(nb);
      void ensureRagIndex(store, settings, nb);

      // Pasted links download in the background; the coach kickoff waits for
      // them (bounded) so its greeting knows the materials.
      const links = typeof body.links === "string" ? parseLinks(body.links) : [];
      if (links.length > 0) {
        void ingestLinks(store, settings, nb.id, links, {
          onSource: () => sessions.broadcastSourcesUpdated(nb.id),
        });
      }

      res.status(201).json({ notebook: toSummary(nb), warnings });
    },
  );

  router.get("/:id", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");

    // Deferred Aria intake for coach-first projects: only the teach-back view
    // calls this endpoint, so the first open is the moment to initialize the
    // setup form (precedent: this handler already mutates intake state below).
    if (nb.createdVia === "coach" && !nb.intake && !nb.kickoffDone && nb.messages.length === 0 && !config.intakeDisabled) {
      nb.intake = { status: "pending", generatedQuestions: null, answers: null, research: "none", submittedAt: null };
      await store.save(nb);
      void sessions.ensureIntakeQuestions(nb);
    }

    if (nb.intake && nb.intake.status === "pending" && nb.intake.generatedQuestions === null) {
      // Wait briefly for question generation; past the cap, lock in the
      // deterministic-only form so it can never change under the user.
      await Promise.race([sessions.ensureIntakeQuestions(nb), new Promise((r) => setTimeout(r, 25_000))]);
      if (nb.intake.generatedQuestions === null) {
        nb.intake.generatedQuestions = [];
        await store.save(nb);
      }
    }
    // Crash recovery: research marked running but no live session → failed.
    if (nb.intake?.research === "running" && !sessions.getState(nb.id).turnActive) {
      nb.intake.research = "failed";
      await store.save(nb);
    }

    const sessionState = sessions.getState(nb.id);
    const intakePending = nb.intake?.status === "pending" && nb.messages.length === 0;
    const knowledgeState = config.learningStateDisabled
      ? null
      : sessionState.turnActive || intakePending
        ? (nb.userKnowledgeState ?? null)
        : await sessions.ensureKnowledgeState(nb.id);

    res.json({
      notebook: toSummary(nb),
      messages: nb.messages,
      turnActive: sessionState.turnActive,
      // Gated so the kill switch hides the map UI too — otherwise a previously
      // generated state would ship frozen, with the evaluator off.
      knowledgeState,
      intake: nb.intake
        ? { status: nb.intake.status, questions: composeIntakeQuestions(nb), research: nb.intake.research }
        : null,
    });
  });

  router.post("/:id/intake", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    if (!nb.intake) throw new HttpError(409, "intake_unavailable", "This notebook has no setup form.");
    if (nb.intake.status === "done" || nb.kickoffDone || nb.messages.length > 0) {
      res.status(202).json({}); // idempotent no-op (double submit)
      return;
    }
    if (sessions.getState(nb.id).turnActive) throw new HttpError(409, "turn_active");

    const body = (req.body ?? {}) as {
      skip?: boolean;
      answers?: Record<string, { value?: string; custom?: string }>;
    };
    const raw = body.answers ?? {};
    const clip = (s: string | undefined) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 500) : null);

    let mapped: IntakeAnswers;
    if (body.skip === true) {
      mapped = {
        level: null,
        levelNote: null,
        research: nb.sourceFiles.length === 0,
        researchNote: null,
        focus: {},
        skipped: true,
      };
    } else {
      const levelCustom = clip(raw.level?.custom);
      const levelValue = raw.level?.value;
      if (levelValue !== undefined && !["fundamental", "standard", "challenge"].includes(levelValue)) {
        throw new HttpError(400, "invalid_answer", `Unknown level "${levelValue}"`);
      }
      const researchCustom = clip(raw.research?.custom);
      const researchValue = raw.research?.value;
      if (researchValue !== undefined && !["yes", "no"].includes(researchValue)) {
        throw new HttpError(400, "invalid_answer", `Unknown research answer "${researchValue}"`);
      }
      const focus: Record<string, string> = {};
      for (const q of nb.intake.generatedQuestions ?? []) {
        const a = raw[q.id];
        const text = clip(a?.custom) ?? clip(a?.value);
        if (text) focus[q.id] = text;
      }
      mapped = {
        level: levelCustom ? null : ((levelValue as IntakeLevel | undefined) ?? null),
        levelNote: levelCustom,
        // A free-text research answer is inherently a "yes, but…".
        research: researchCustom ? true : researchValue === undefined ? true : researchValue === "yes",
        researchNote: researchCustom,
        focus,
        skipped: false,
      };
    }

    nb.intake.answers = mapped;
    nb.intake.status = "done";
    nb.intake.submittedAt = new Date().toISOString();
    nb.intake.research = mapped.research ? "running" : "none";
    await store.save(nb);

    // Call before responding: the pipeline's synchronous prefix occupies the
    // turn state machine, closing the race with a concurrent /messages POST.
    const pipeline = sessions.runIntakePipeline(nb.id);
    res.status(202).json({});
    void pipeline.catch((err) => console.error("[aria] intake pipeline failed:", err));
  });

  router.post(
    "/:id/sources",
    (req: UploadRequest, _res, next) => {
      const nb = store.get(req.params.id as string);
      if (!nb) {
        next(new HttpError(404, "notebook_not_found"));
        return;
      }
      req.notebookId = nb.id;
      // Dedupe new uploads against everything already in the sources dir.
      req.usedNames = new Set(
        nb.sourceFiles.flatMap((f) => (f.extractedName ? [f.storedName, f.extractedName] : [f.storedName])),
      );
      next();
    },
    // Unlike creation, the notebook dir must survive a failed upload — only
    // remove the partially-written new files.
    (req: UploadRequest, res, next) => {
      uploadFiles(req, res, (err: unknown) => {
        if (!err) return next();
        const written = (req.files as Express.Multer.File[] | undefined) ?? [];
        for (const f of written) void fs.rm(f.path, { force: true }).catch(() => {});
        if (err instanceof multer.MulterError) {
          const message =
            err.code === "LIMIT_FILE_SIZE"
              ? "Each file must be under 25MB"
              : err.code === "LIMIT_FILE_COUNT"
                ? "You can upload at most 10 files at once"
                : err.message;
          next(new HttpError(400, "upload_rejected", message));
        } else {
          next(err);
        }
      });
    },
    async (req: UploadRequest, res) => {
      const nb = store.get(req.notebookId!)!;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) throw new HttpError(400, "missing_files", "At least one file is required");

      const { sourceFiles, warnings } = await processUploads(store, nb.id, files, req.usedNames!);
      nb.sourceFiles.push(...sourceFiles);
      // The live thread's instructions can't change — the student learns about
      // these on the next turn via a hidden note (see session.ts).
      nb.pendingNewSources = [...(nb.pendingNewSources ?? []), ...sourceFiles.map((f) => f.storedName)];
      // Same for the coach's pinned manifest (its own note list — see coach-session.ts).
      if (nb.coach?.kickoffDone) {
        nb.coach.pendingSourceNotes = [...(nb.coach.pendingSourceNotes ?? []), ...sourceFiles.map((f) => f.originalName)].slice(-10);
      }
      await store.save(nb);
      // An explicit upload is also the user's signal to retry a failed embedder.
      void ensureRagIndex(store, settings, nb, { retryNow: true });
      void sessions.rebuildKnowledgeStateForNotebook(nb.id).catch((err) =>
        console.error(`[aria] user knowledge rebuild after upload failed for notebook ${nb.id}:`, err),
      );

      res.status(201).json({ notebook: toSummary(nb), added: sourceFiles, warnings });
    },
  );

  router.delete("/:id/sources/:name", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const file = nb.sourceFiles.find((f) => f.storedName === req.params.name);
    if (!file) throw new HttpError(404, "source_not_found");

    await fs.rm(path.join(store.sourcesDir(nb.id), file.storedName), { force: true });
    if (file.extractedName) {
      await fs.rm(path.join(store.sourcesDir(nb.id), file.extractedName), { force: true });
    }
    nb.sourceFiles = nb.sourceFiles.filter((f) => f.storedName !== file.storedName);
    // If the student was never told about this file (added and deleted between
    // turns), drop the announcement and say nothing. Otherwise the pinned
    // instructions still list it as reading — queue a removal note so the
    // student stops treating it as assigned (see session.ts).
    const neverAnnounced = (nb.pendingNewSources ?? []).includes(file.storedName);
    if (nb.pendingNewSources?.length) {
      nb.pendingNewSources = nb.pendingNewSources.filter((s) => s !== file.storedName);
    }
    if (!neverAnnounced) {
      nb.pendingRemovedSources = [...(nb.pendingRemovedSources ?? []), file.originalName];
    }
    await store.save(nb);
    // Retrieval already filters deleted sources by storedName; the rebuild compacts.
    void ensureRagIndex(store, settings, nb, { retryNow: true });
    void sessions.rebuildKnowledgeStateForNotebook(nb.id).catch((err) =>
      console.error(`[aria] user knowledge rebuild after source delete failed for notebook ${nb.id}:`, err),
    );

    res.json({ notebook: toSummary(nb) });
  });

  router.post("/:id/discover", async (req, res) => {
    const body = (req.body ?? {}) as { query?: string };
    const query = typeof body.query === "string" && body.query.trim() ? body.query.trim().slice(0, 300) : null;
    const result = await sessions.startDiscovery(req.params.id, query);
    res.status(202).json(result);
  });

  router.get("/:id/sources/:name", (req, res, next) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const file = nb.sourceFiles.find((f) => f.storedName === req.params.name);
    if (!file) throw new HttpError(404, "source_not_found");

    // Traversal is impossible: the name must exactly equal a storedName
    // produced by sanitizeName ([a-z0-9._-] only); root is belt-and-braces.
    const ext = path.extname(file.storedName).toLowerCase();
    res.type(ext === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8");
    res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
    res.sendFile(file.storedName, { root: store.sourcesDir(nb.id) }, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, "source_file_missing"));
    });
  });

  router.delete("/:id", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    await sessions.dispose(nb.id);
    await cyra.disposeNotebook(nb.id);
    await coach.disposeNotebook(nb.id);
    dropRagIndex(nb.id);
    await store.delete(nb.id);
    res.status(204).end();
  });

  // ---------- "Ask Cyra" expert threads ----------

  const validClientMessageId = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined;

  router.get("/:id/cyra", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    res.json({ threads: (nb.cyraThreads ?? []).map(toCyraThreadSummary) });
  });

  // Create-on-first-send: thread record + seed message + first turn, atomically.
  router.post("/:id/cyra", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const body = (req.body ?? {}) as { text?: string; clientMessageId?: string; sourceMessageId?: string };
    const result = await cyra.startTurn(nb.id, {
      cyraThreadId: null,
      text: body.text,
      clientMessageId: validClientMessageId(body.clientMessageId),
      sourceMessageId: typeof body.sourceMessageId === "string" ? body.sourceMessageId : null,
    });
    usage.recordUse("ask-expert");
    res.status(201).json(result);
  });

  router.get("/:id/cyra/:tid", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const ct = nb.cyraThreads?.find((t) => t.id === req.params.tid);
    if (!ct) throw new HttpError(404, "cyra_thread_not_found");
    res.json({
      thread: toCyraThreadSummary(ct),
      messages: ct.messages,
      turnActive: cyra.getState(ct.id).turnActive,
    });
  });

  router.post("/:id/cyra/:tid/messages", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; retry?: boolean; clientMessageId?: string };
    const result = await cyra.startTurn(req.params.id, {
      cyraThreadId: req.params.tid,
      text: body.text,
      retry: body.retry === true,
      clientMessageId: validClientMessageId(body.clientMessageId),
    });
    res.status(202).json({ turnId: result.turnId });
  });

  // Rewind-and-resend within a Cyra conversation.
  router.post("/:id/cyra/:tid/messages/:mid/edit", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; clientMessageId?: string };
    const result = await cyra.editTurn(
      req.params.id,
      req.params.tid,
      req.params.mid,
      body.text,
      validClientMessageId(body.clientMessageId),
    );
    res.status(202).json({ turnId: result.turnId });
  });

  router.post("/:id/cyra/:tid/interrupt", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    await cyra.interrupt(nb.id, req.params.tid);
    res.status(202).json({});
  });

  router.get("/:id/cyra/:tid/events", (req, res) => {
    cyra.attach(req.params.id, req.params.tid, res);
  });

  // ---------- Learning coach ----------

  // Lazily initialize the coach conversation (pre-pivot notebooks get one on
  // first open in the coach shell). Read-check-then-set on the live object;
  // concurrent inits write identical values through the per-notebook save chain.
  router.get("/:id/coach", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const hadCoach = nb.coach !== undefined;
    const state = ensureCoachState(nb);
    if (!hadCoach) await store.save(nb);
    res.json({
      coach: { kickoffDone: state.kickoffDone },
      messages: state.messages,
      turnActive: coach.getState(nb.id).turnActive,
    });
  });

  // Idempotent kickoff: no-op once done or while a turn is active.
  router.post("/:id/coach/kickoff", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const state = ensureCoachState(nb);
    if (state.kickoffDone || coach.getState(nb.id).turnActive) {
      res.status(202).json({ turnId: null });
      return;
    }
    // Give pasted links a chance to land so the greeting knows the materials.
    const { stillRunning } = await awaitLinkIngestion(nb.id, 45_000);
    // Re-check after the wait: another tab may have kicked off meanwhile.
    if (state.kickoffDone || coach.getState(nb.id).turnActive) {
      res.status(202).json({ turnId: null });
      return;
    }
    const result = await coach.startTurn(nb.id, { kickoff: true, sourcesPending: stillRunning });
    res.status(202).json({ turnId: result.turnId });
  });

  router.post("/:id/coach/messages", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    ensureCoachState(nb);
    const body = (req.body ?? {}) as { text?: string; retry?: boolean; clientMessageId?: string };
    const result = await coach.startTurn(nb.id, {
      text: body.text,
      retry: body.retry === true,
      clientMessageId: validClientMessageId(body.clientMessageId),
    });
    res.status(202).json({ turnId: result.turnId });
  });

  // Rewind-and-resend within the coach conversation.
  router.post("/:id/coach/messages/:mid/edit", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; clientMessageId?: string };
    const result = await coach.editTurn(req.params.id, req.params.mid, body.text, validClientMessageId(body.clientMessageId));
    res.status(202).json({ turnId: result.turnId });
  });

  router.post("/:id/coach/interrupt", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    await coach.interrupt(nb.id);
    res.status(202).json({});
  });

  router.get("/:id/coach/events", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    if (!nb.coach) ensureCoachState(nb); // benign in-memory init; persisted on first real write
    coach.attach(nb.id, res);
  });

  // ---------- Guided reading ----------

  const READING_LEVELS: ReadingLevel[] = ["beginner", "intermediate", "experienced"];

  router.get("/:id/reading", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    // Crash recovery: a session left "generating" by a dead process can never finish.
    let dirty = false;
    for (const rs of nb.readingSessions ?? []) {
      if (isGenerationOrphaned(rs)) {
        rs.status = "failed";
        rs.error = "Preparation was interrupted. Create the reading again.";
        dirty = true;
      }
    }
    if (dirty) await store.save(nb);
    res.json({ sessions: (nb.readingSessions ?? []).map(toReadingSummary) });
  });

  router.post("/:id/reading", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const body = (req.body ?? {}) as { source?: string; level?: string };
    if (typeof body.source !== "string" || !body.source) throw new HttpError(400, "missing_source");
    const level = READING_LEVELS.includes(body.level as ReadingLevel) ? (body.level as ReadingLevel) : "beginner";
    const session = await createReadingSession(client, store, settings, nb, body.source, level);
    usage.recordUse(`guided-reading:${level}`);
    res.status(201).json({ session });
  });

  router.get("/:id/reading/:rid", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const rs = nb.readingSessions?.find((r) => r.id === req.params.rid);
    if (!rs) throw new HttpError(404, "reading_not_found");
    if (isGenerationOrphaned(rs)) {
      rs.status = "failed";
      rs.error = "Preparation was interrupted. Create the reading again.";
      await store.save(nb);
    }
    res.json({ session: rs });
  });

  // Persist the learner's response / resolved state on one annotation.
  router.patch("/:id/reading/:rid/annotations/:aid", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const rs = nb.readingSessions?.find((r) => r.id === req.params.rid);
    if (!rs) throw new HttpError(404, "reading_not_found");
    const ann = rs.annotations.find((a) => a.id === req.params.aid);
    if (!ann) throw new HttpError(404, "annotation_not_found");
    const body = (req.body ?? {}) as { userResponse?: unknown; resolved?: unknown };
    if (typeof body.userResponse === "string") ann.userResponse = body.userResponse.slice(0, 4000);
    if (typeof body.resolved === "boolean") ann.resolved = body.resolved;
    rs.updatedAt = new Date().toISOString();
    await store.save(nb);
    res.json({ annotation: ann });
  });

  router.delete("/:id/reading/:rid", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const before = nb.readingSessions?.length ?? 0;
    nb.readingSessions = (nb.readingSessions ?? []).filter((r) => r.id !== req.params.rid);
    if (nb.readingSessions.length === before) throw new HttpError(404, "reading_not_found");
    await store.save(nb);
    res.status(204).end();
  });

  // ---------- Learning log (journey.ts) ----------

  router.get("/:id/log", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    res.json({ entries: nb.learningLog ?? [], due: computeDueTopics(nb) });
  });

  router.post("/:id/log", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const topic = clip(body.topic, 120);
    if (!topic) throw new HttpError(400, "missing_topic", "A topic is required");
    nb.learningLog ??= [];
    // Coach-drafted cards send id "log:<messageId>" — confirming one twice
    // (double click, reload) must return the existing entry, not duplicate.
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 100) : randomUUID();
    const existing = nb.learningLog.find((e) => e.id === id);
    if (existing) {
      res.json({ entry: existing, due: computeDueTopics(nb) });
      return;
    }
    const entry: LearningLogEntry = {
      id,
      topic,
      goal: clip(body.goal, 300),
      strategy: clip(body.strategy, 300),
      resultGap: clip(body.resultGap, 500),
      nextMove: clip(body.nextMove, 300),
      source: body.source === "coach" ? "coach" : "user",
      createdAt: new Date().toISOString(),
    };
    nb.learningLog.push(entry);
    await store.save(nb);
    usage.recordUse("learning-log");
    res.status(201).json({ entry, due: computeDueTopics(nb) });
  });

  router.patch("/:id/log/:eid", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const entry = nb.learningLog?.find((e) => e.id === req.params.eid);
    if (!entry) throw new HttpError(404, "log_entry_not_found");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    const topic = clip(body.topic, 120);
    if (topic) entry.topic = topic;
    const goal = clip(body.goal, 300);
    if (goal !== undefined) entry.goal = goal;
    const strategy = clip(body.strategy, 300);
    if (strategy !== undefined) entry.strategy = strategy;
    const resultGap = clip(body.resultGap, 500);
    if (resultGap !== undefined) entry.resultGap = resultGap;
    const nextMove = clip(body.nextMove, 300);
    if (nextMove !== undefined) entry.nextMove = nextMove;
    entry.updatedAt = new Date().toISOString();
    await store.save(nb);
    res.json({ entry, due: computeDueTopics(nb) });
  });

  router.delete("/:id/log/:eid", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const before = nb.learningLog?.length ?? 0;
    nb.learningLog = (nb.learningLog ?? []).filter((e) => e.id !== req.params.eid);
    if (nb.learningLog.length === before) throw new HttpError(404, "log_entry_not_found");
    await store.save(nb);
    res.status(204).end();
  });

  router.post("/:id/messages", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; retry?: boolean; clientMessageId?: string };
    // A teach-back "use" is a teaching session, not a message: count when the
    // notebook has no messages yet or the last one is more than 4 hours old.
    const nbBefore = store.get(req.params.id);
    const lastMsg = nbBefore?.messages[nbBefore.messages.length - 1];
    const newSession = !lastMsg || Date.now() - new Date(lastMsg.createdAt).getTime() > SESSION_GAP_MS;
    const result = await sessions.startTurn(
      req.params.id,
      body.text,
      body.retry === true,
      validClientMessageId(body.clientMessageId),
    );
    if (newSession && body.retry !== true) usage.recordUse("teach-back");
    res.status(202).json(result);
  });

  // Rewind-and-resend: replaces the message and deletes everything after it.
  router.post("/:id/messages/:mid/edit", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; clientMessageId?: string };
    const result = await sessions.editTurn(
      req.params.id,
      req.params.mid,
      body.text,
      validClientMessageId(body.clientMessageId),
    );
    res.status(202).json(result);
  });

  router.post("/:id/interrupt", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    await sessions.interrupt(nb.id);
    res.status(202).json({});
  });

  router.get("/:id/events", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    sessions.attach(nb.id, res);
  });

  return router;
}
