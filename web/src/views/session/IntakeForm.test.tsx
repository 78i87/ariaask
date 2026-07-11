import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
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
});
