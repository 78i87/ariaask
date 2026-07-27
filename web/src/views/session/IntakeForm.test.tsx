import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntakeForm } from "./IntakeForm";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("720px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

describe("IntakeForm mobile flow", () => {
  it("separates the starting point from focus questions", async () => {
    const user = userEvent.setup();
    render(
      <IntakeForm
        submitting={false}
        onSkip={() => {}}
        onSubmit={() => {}}
        questions={[
          { id: "level", question: "Starting point", allowsCustom: false, options: [{ value: "standard", label: "Standard" }] },
          { id: "focus", question: "Focus first", allowsCustom: false, options: [{ value: "rates", label: "Rates" }] },
        ]}
      />,
    );
    expect(screen.getByText("Step 1 of 2 · Starting point")).toBeInTheDocument();
    expect(screen.queryByText("Focus first")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 2 · Focus and readings")).toBeInTheDocument();
    expect(screen.getByText("Focus first")).toBeInTheDocument();
  });

  it("splits interview format from round and research, then starts the interview", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <IntakeForm
        interview
        submitting={false}
        onSkip={() => {}}
        onSubmit={onSubmit}
        questions={[
          { id: "format", question: "Interview format", allowsCustom: false, options: [{ value: "mixed", label: "Mixed" }] },
          { id: "round", question: "Interview round", allowsCustom: false, options: [{ value: "not-sure", label: "Not sure" }] },
          { id: "research", question: "Research first", allowsCustom: false, options: [{ value: "yes", label: "Yes" }] },
        ]}
      />,
    );

    expect(screen.getByText("Step 1 of 2 · Interview format")).toBeInTheDocument();
    expect(screen.getByText("Interview format", { selector: "legend" })).toBeInTheDocument();
    expect(screen.queryByText("Interview round")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 2 · Round and research")).toBeInTheDocument();
    expect(screen.getByText("Interview round")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start interview" }));
    expect(onSubmit).toHaveBeenCalledWith({
      format: { value: "mixed" },
      research: { value: "yes" },
      round: { value: "not-sure" },
    });
  });
});
