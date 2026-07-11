import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notebook } from "../../lib/types";
import { NotebookCard } from "./NotebookCard";

const notebook: Notebook = {
  id: "n1",
  title: "Compound interest",
  topic: "Compound interest",
  type: "topic",
  sourceFiles: [],
  createdAt: "2026-07-11T00:00:00.000Z",
  lastTaughtAt: null,
  messageCount: 0,
  archivedAt: null,
};

describe("NotebookCard", () => {
  it("suppresses duplicate topic metadata and supports inline rename", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => true);
    const onOpen = vi.fn();
    render(
      <NotebookCard
        notebook={notebook}
        index={0}
        onOpen={onOpen}
        onDelete={() => {}}
        onArchive={() => {}}
        onRestore={() => {}}
        onRename={onRename}
      />,
    );
    expect(screen.getByText("Never taught")).toBeInTheDocument();
    expect(screen.queryByText(/Compound interest · Never taught/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notebook options" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Notebook title" });
    await user.clear(input);
    await user.type(input, "Interest basics");
    await user.click(screen.getByText("Never taught"));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Interest basics"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
