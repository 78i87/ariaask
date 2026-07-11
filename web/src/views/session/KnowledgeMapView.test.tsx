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

  it("relabels the outline as interview coverage", () => {
    localStorage.removeItem("aria-knowledge-map-mode");
    const state: KnowledgeState = {
      version: 1,
      beliefs: [
        belief("architecture", "understood"),
        belief("performance", "partial"),
        belief("accessibility", "misconception"),
        belief("mentoring", "unknown"),
      ],
      lastChanges: [],
      lastEvaluatedMessageId: null,
      updatedAt: "2026-07-11T00:00:00.000Z",
    };

    render(<KnowledgeMapView state={state} mode="interview" />);

    expect(screen.getByText("1 of 4 strong")).toBeInTheDocument();
    expect(screen.getByText("Probe next")).toBeInTheDocument();
    expect(screen.getByText("4 competencies")).toBeInTheDocument();
    expect(screen.getAllByText("Strong").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Touched on").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Struggled").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not probed").length).toBeGreaterThan(0);
  });
});
