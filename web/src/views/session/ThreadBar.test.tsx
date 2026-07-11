import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadBar } from "./ThreadBar";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

describe("ThreadBar mobile navigation", () => {
  it("keeps the selected conversation visible and moves the rest into a menu", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadBar
        active={{ kind: "cyra", threadId: "two" }}
        threads={[
          { id: "one", title: "First question", sourceMessageId: null, messageCount: 1, createdAt: "", updatedAt: "" },
          { id: "two", title: "Selected question", sourceMessageId: null, messageCount: 1, createdAt: "", updatedAt: "" },
        ]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("button", { name: "Selected question" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "First question" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More conversations" }));
    await user.click(screen.getByRole("menuitem", { name: "First question" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "cyra", threadId: "one" });
  });
});
