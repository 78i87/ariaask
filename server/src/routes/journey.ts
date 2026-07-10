import { Router } from "express";
import type { NotebookStore } from "../domain/store.js";
import { computeDueTopics } from "../domain/journey.js";

export interface GlobalDueTopic {
  notebookId: string;
  notebookTitle: string;
  topic: string;
  daysSince: number;
  intervalDays: number;
}

/**
 * Cross-project journey aggregates. Mounted at /api/journey (its own router:
 * /api/notebooks/:id would swallow a literal "due" segment).
 */
export function journeyRoutes(store: NotebookStore): Router {
  const router = Router();

  // Topics worth a quick return across ALL projects, for the shell sidebar.
  router.get("/due", (_req, res) => {
    const due: GlobalDueTopic[] = [];
    for (const summary of store.list()) {
      const nb = store.get(summary.id);
      if (!nb) continue;
      for (const d of computeDueTopics(nb)) {
        due.push({
          notebookId: nb.id,
          notebookTitle: nb.title,
          topic: d.topic,
          daysSince: d.daysSince,
          intervalDays: d.intervalDays,
        });
      }
    }
    due.sort((a, b) => b.daysSince / b.intervalDays - a.daysSince / a.intervalDays);
    res.json({ due: due.slice(0, 3) });
  });

  return router;
}
