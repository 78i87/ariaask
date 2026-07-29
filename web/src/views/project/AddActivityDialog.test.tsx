import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnackbarProvider } from "../../components/Snackbar";
import type { Notebook, ProjectActivity } from "../../lib/types";
import { AddActivityDialog } from "./AddActivityDialog";

const project: Notebook = {
  id: "project-1",
  title: "Backend roles",
  goal: "Prepare for backend engineering roles",
  sourceFiles: [
    {
      originalName: "Morgan CV.txt",
      storedName: "morgan-cv.txt",
      extractedName: null,
      mimeType: "text/plain",
      size: 100,
      approxWords: 20,
    },
  ],
  activities: [],
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  archivedAt: null,
};

function activity(kind: ProjectActivity["kind"]): ProjectActivity {
  return {
    id: `${kind}-1`,
    kind,
    title: kind === "coach" ? "Learning coach" : "Backend engineer interview",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    messageCount: 0,
    setupComplete: true,
  };
}

afterEach(cleanup);

describe("AddActivityDialog", () => {
  it("creates a coach immediately as an independent activity", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (form: FormData) => {
      expect(form.get("kind")).toBe("coach");
      return activity("coach");
    });

    render(<AddActivityDialog open project={project} onClose={() => {}} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: /Learning coach/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it("requires a role and binds an existing project CV for interviews", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (form: FormData) => {
      expect(form.get("kind")).toBe("interview");
      expect(form.get("role")).toBe("Backend engineer");
      expect(form.get("cvSource")).toBe("morgan-cv.txt");
      return activity("interview");
    });

    render(<AddActivityDialog open project={project} onClose={() => {}} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: /Interview practice/ }));
    const addButton = screen.getByRole("button", { name: "Add interview" });
    expect(addButton).toBeDisabled();
    await user.type(screen.getByLabelText("Target role"), "Backend engineer");
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it("shows creation errors and preserves the dialog for retry", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error("The activity could not be created");
    });

    render(
      <SnackbarProvider>
        <AddActivityDialog open project={project} onClose={() => {}} onCreate={onCreate} />
      </SnackbarProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Learning coach/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("The activity could not be created");
    expect(screen.getByRole("heading", { name: "Add activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Learning coach/ })).toBeEnabled();
  });
});
