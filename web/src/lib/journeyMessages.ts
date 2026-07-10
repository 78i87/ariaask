/**
 * Canonical journey message strings. The coach persona (server/src/domain/coach.ts)
 * recognizes these exact shapes — they live in ONE module so persona and
 * client never drift.
 */

/** User messages starting with this set/replace the session's one-line goal. */
export const GOAL_PREFIX = "Today's target: ";

/** Asks the coach to close the study block and draft the ```log entry. */
export const WRAP_UP_MESSAGE = "Wrapping up this session — draft my log entry.";

/** Opens a spaced return on a topic — the coach must reply retrieval-first. */
export const quickReturnMessage = (topic: string): string =>
  `Quick return: "${topic}" — test me before anything else.`;

/** Plain re-entry after a break; the server injects the [SESSION] ritual regardless. */
export const CONTINUE_MESSAGE = "I'm back — let's pick up where we left off.";

/** Asks the coach to turn the project's goal + materials into a ```plan block. */
export const PLAN_REQUEST_MESSAGE = "Draft me a study plan for this project — use my goal and materials.";

/** Starts a plan task — the coach coaches them through THAT task. */
export const startTaskMessage = (position: number, title: string): string =>
  `Let's work on task ${position}: "${title}".`;
