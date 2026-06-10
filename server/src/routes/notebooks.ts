import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import multer from "multer";
import { HttpError } from "../lib/errors.js";
import type { NotebookStore, SourceFile } from "../domain/store.js";
import { toSummary } from "../domain/store.js";
import type { SessionManager } from "../domain/session.js";
import { approxWordCount, extractPdfText } from "../domain/extract.js";

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

function sanitizeName(original: string, used: Set<string>): string {
  const ext = path.extname(original).toLowerCase();
  const stem =
    path
      .basename(original, path.extname(original))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "source";
  let candidate = stem + ext;
  let n = 1;
  while (used.has(candidate)) candidate = `${stem}-${n++}${ext}`;
  used.add(candidate);
  return candidate;
}

export function notebookRoutes(store: NotebookStore, sessions: SessionManager): Router {
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
      await store.save(nb);

      res.status(201).json({ notebook: toSummary(nb), warnings });
    },
  );

  router.get("/:id", (req, res) => {
    const nb = store.get(req.params.id);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    res.json({
      notebook: toSummary(nb),
      messages: nb.messages,
      turnActive: sessions.getState(nb.id).turnActive,
      learningState: nb.learningState ?? null,
    });
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

      res.status(201).json({ notebook: toSummary(nb), added: sourceFiles, warnings });
    },
  );

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
    await store.delete(nb.id);
    res.status(204).end();
  });

  router.post("/:id/messages", async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; retry?: boolean; clientMessageId?: string };
    const clientMessageId =
      typeof body.clientMessageId === "string" && body.clientMessageId.length > 0 && body.clientMessageId.length <= 64
        ? body.clientMessageId
        : undefined;
    const result = await sessions.startTurn(req.params.id, body.text, body.retry === true, clientMessageId);
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
