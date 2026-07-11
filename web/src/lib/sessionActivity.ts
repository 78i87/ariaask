import type { SessionActivity, SessionStateEvent } from "./types";

export function activityFromSessionState(state: SessionStateEvent): SessionActivity | null {
  return state.activity ?? (state.intakeRunning ? { kind: "researching", phase: "searching" } : null);
}
