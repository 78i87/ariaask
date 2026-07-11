import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { KnowledgeBelief, KnowledgeState } from "../../lib/types";
import { KnowledgeMapView, rankTeachNext } from "./KnowledgeMapView";

const belief = (id: string, status: KnowledgeBelief["status"], deps: string[] = []): KnowledgeBelief => ({
  id,
  concept: id,
  status,
  belief: `${id} evidence`,
  deps,
});

describe("rankTeachNext", () => {
  it("prioritizes misconceptions, partials, and then ready unknown concepts", () => {
    const ranked = rankTeachNext([
      belief("foundation", "understood"),
      belief("blocked", "unknown", ["missing"]),
      belief("ready", "unknown", ["foundation"]),
      belief("partial", "partial"),
      belief("wrong", "misconception"),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["wrong", "partial", "ready"]);
  });

  it("applies the settled graph positions when Constellation mounts after Outline", async () => {
    localStorage.removeItem("aria-knowledge-map-mode");
    const user = userEvent.setup();
    const state: KnowledgeState = {
      version: 1,
      beliefs: [belief("foundation", "unknown"), belief("next", "unknown", ["foundation"])],
      lastChanges: [],
      lastEvaluatedMessageId: null,
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const { container } = render(<KnowledgeMapView state={state} />);

    expect(screen.getByRole("radio", { name: "Outline" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Constellation" }));

    expect(screen.getByRole("application", { name: "Your knowledge map graph" })).toHaveAttribute("viewBox");
    const nodes = container.querySelectorAll(".kgraph__node[transform]");
    expect(nodes).toHaveLength(2);
  });
});
