import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notebook } from "../../lib/types";
import { SnackbarProvider } from "../../components/Snackbar";
import { CreateNotebookDialog } from "./CreateNotebookDialog";

const project: Notebook = {
  id: "project-1",
  title: "Distributed systems",
  goal: "Distributed systems",
  sourceFiles: [],
  activities: [],
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  archivedAt: null,
};

describe("CreateNotebookDialog", () => {
  it("creates a neutral project without asking for an activity kind", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (form: FormData) => {
      expect(form.get("goal")).toBe("Distributed systems");
      expect(form.get("type")).toBeNull();
      return { notebook: project, warnings: [] };
    });
    const onCreated = vi.fn();

    render(
      <SnackbarProvider>
        <CreateNotebookDialog
          open
          onClose={() => {}}
          onCreate={onCreate}
          onCreated={onCreated}
        />
      </SnackbarProvider>,
    );

    expect(screen.queryByRole("radio", { name: "Learn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Interview" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("What are you working on?"), "Distributed systems");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
  });
});
