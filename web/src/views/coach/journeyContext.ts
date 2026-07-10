import { createContext, useContext } from "react";
import type { DueTopic, LearningLogEntry, StudyPlan } from "../../lib/types";

/**
 * The current project's learning log + due-return + study-plan state,
 * provided by CoachShell (one fetch per project open) and shared by
 * everything that touches it: the Journey dialog, in-chat ```log / ```plan
 * confirm cards, and the session bar. Mirrors the coachActions context
 * pattern — react-markdown component overrides can't take props, so cards
 * reach up via context.
 */
export interface Journey {
  entries: LearningLogEntry[];
  due: DueTopic[];
  plan: StudyPlan | null;
  refresh: () => void;
  /** Create an entry (idempotent on id server-side) and update local state. */
  addEntry: (body: Partial<LearningLogEntry> & { topic: string }) => Promise<LearningLogEntry>;
  /** Create/replace the plan (idempotent on plan id) and update local state. */
  savePlan: (body: { id?: string; source?: "coach" | "user"; tasks: { title: string; detail?: string; topic?: string }[] }) => Promise<StudyPlan>;
  /** Toggle one task's completion. */
  setTaskStatus: (taskId: string, status: "pending" | "done") => Promise<void>;
}

export const JourneyContext = createContext<Journey>({
  entries: [],
  due: [],
  plan: null,
  refresh: () => {},
  addEntry: () => Promise.reject(new Error("journey unavailable")),
  savePlan: () => Promise.reject(new Error("journey unavailable")),
  setTaskStatus: () => Promise.reject(new Error("journey unavailable")),
});

export function useJourney(): Journey {
  return useContext(JourneyContext);
}
