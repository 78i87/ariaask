import { describe, expect, it } from "vitest";
import type { SessionStateEvent } from "./types";
import { activityFromSessionState } from "./sessionActivity";

const state = (patch: Partial<SessionStateEvent>): SessionStateEvent => ({
  turnActive: false,
  turnId: null,
  kickoffRunning: false,
  intakeRunning: false,
  partials: {},
  messageCount: 0,
  ...patch,
});

describe("activityFromSessionState", () => {
  it("restores background discovery progress while no turn is active", () => {
    expect(
      activityFromSessionState(
        state({
          discoveryRunning: true,
          activity: { kind: "researching", phase: "downloading", completed: 2, total: 4 },
        }),
      ),
    ).toEqual({ kind: "researching", phase: "downloading", completed: 2, total: 4 });
  });

  it("clears stale activity when an idle snapshot has none", () => {
    expect(activityFromSessionState(state({}))).toBeNull();
  });
});
