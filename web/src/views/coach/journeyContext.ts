import { createContext, useContext } from "react";
import type { DueTopic, LearningLogEntry } from "../../lib/types";

/**
 * The current project's learning log + due-return state, provided by
 * CoachShell (one fetch per project open) and shared by everything that
 * touches it: the Journey dialog, in-chat ```log confirm cards, and the
 * session bar. Mirrors the coachActions context pattern — react-markdown
 * component overrides can't take props, so cards reach up via context.
 */
export interface Journey {
  entries: LearningLogEntry[];
  due: DueTopic[];
  refresh: () => void;
  /** Create an entry (idempotent on id server-side) and update local state. */
  addEntry: (body: Partial<LearningLogEntry> & { topic: string }) => Promise<LearningLogEntry>;
}

export const JourneyContext = createContext<Journey>({
  entries: [],
  due: [],
  refresh: () => {},
  addEntry: () => Promise.reject(new Error("journey unavailable")),
});

export function useJourney(): Journey {
  return useContext(JourneyContext);
}
