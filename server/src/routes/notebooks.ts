import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import multer from "multer";
import { HttpError } from "../lib/errors.js";
import type { NotebookStore, SourceFile } from "../domain/store.js";
import { sanitizeName, toCyraThreadSummary, toSummary } from "../domain/store.js";
import type { SessionManager } from "../domain/session.js";
import type { CyraSessionManager } from "../domain/cyra-session.js";
import { approxWordCount, extractPdfText } from "../domain/extract.js";
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
      if (!config.intakeDisabled) {
        nb.intake = { status: "pending", generatedQuestions: null, answers: null, research: "none", submittedAt: null };
      }
      await store.save(nb);
      // Head start: generate the model-authored setup questions while the
      // user's browser navigates to the session.
      if (nb.intake) void sessions.ensureIntakeQuestions(nb);
      void ensureRagIndex(store, settings, nb);

      res.status(201).json({ notebook: toSummary(nb), warnings });
    },
  );

  router.get("/:id", async (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");

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

    res.json({
      notebook: toSummary(nb),
      messages: nb.messages,
      turnActive: sessions.getState(nb.id).turnActive,
      learningState: nb.learningState ?? null,
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
      await store.save(nb);
      // An explicit upload is also the user's signal to retry a failed embedder.
      void ensureRagIndex(store, settings, nb, { retryNow: true });

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

    res.json({ notebook: toSummary(nb) });
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

  router.post("/:id/messages", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; retry?: boolean; clientMessageId?: string };
    const result = await sessions.startTurn(
      req.params.id,
      body.text,
      body.retry === true,
      validClientMessageId(body.clientMessageId),
    );
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
