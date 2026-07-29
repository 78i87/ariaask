import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnackbarProvider } from "../../components/Snackbar";
import { api } from "../../lib/api";
import type { Notebook, ProjectActivity } from "../../lib/types";
import { AddSourcesDialog } from "./AddSourcesDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(onDiscover = vi.fn(async () => {})) {
  render(
    <SnackbarProvider>
      <AddSourcesDialog
        open
        notebookId="project-1"
        activityId="activity-1"
        discovering={false}
        kickoffRunning={false}
        intakePending={false}
        initialMode="online"
        onClose={() => {}}
        onAdded={() => {}}
        onDiscover={onDiscover}
      />
    </SnackbarProvider>,
  );
  return onDiscover;
}

describe("AddSourcesDialog guided discovery", () => {
  it("asks adaptive questions and submits selected plus custom refinements", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "clarifyDiscovery").mockResolvedValue({
      tailored: true,
      questions: [
        {
          id: "depth",
          question: "What depth should the sources target?",
          options: [
            { value: "Overview", label: "Overview" },
            { value: "Practical", label: "Practical" },
            { value: "Research", label: "Research" },
          ],
          allowsCustom: true,
        },
        {
          id: "format",
          question: "Which source style helps most?",
          options: [
            { value: "Docs", label: "Docs" },
            { value: "Course notes", label: "Course notes" },
            { value: "Papers", label: "Papers" },
          ],
          allowsCustom: true,
        },
      ],
    });
    const onDiscover = renderDialog();

    const request = screen.getByLabelText("What should these sources help you do?");
    expect(request).toHaveValue("");
    await user.type(request, "Help me design a replicated key-value store");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("radiogroup", { name: "What depth should the sources target?" });
    expect(api.clarifyDiscovery).toHaveBeenCalledWith("project-1", {
      request: "Help me design a replicated key-value store",
      activityId: "activity-1",
    });

    await user.click(screen.getByRole("radio", { name: "Practical" }));
    const formatGroup = screen.getByRole("radiogroup", { name: "Which source style helps most?" });
    await user.click(within(formatGroup).getByRole("radio", { name: "Other…" }));
    await user.type(screen.getByLabelText("Describe it your way"), "Worked architecture case studies");
    await user.click(screen.getByRole("button", { name: "Find sources" }));

    await waitFor(() =>
      expect(onDiscover).toHaveBeenCalledWith({
        request: "Help me design a replicated key-value store",
        activityId: "activity-1",
        refinements: [
          { question: "What depth should the sources target?", answer: "Practical" },
          { question: "Which source style helps most?", answer: "Worked architecture case studies" },
        ],
      }),
    );
  });

  it("allows immediate search when the request is already specific", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "clarifyDiscovery").mockResolvedValue({ tailored: true, questions: [] });
    const onDiscover = renderDialog();

    await user.type(
      screen.getByLabelText("What should these sources help you do?"),
      "Help me compare Raft and Paxos",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Aria has enough context to search well.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Find sources" }));
    await waitFor(() =>
      expect(onDiscover).toHaveBeenCalledWith({
        request: "Help me compare Raft and Paxos",
        activityId: "activity-1",
        refinements: [],
      }),
    );
  });

  it("fails open when tailored question generation is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "clarifyDiscovery").mockResolvedValue({ tailored: false, questions: [] });
    const onDiscover = renderDialog();

    await user.type(
      screen.getByLabelText("What should these sources help you do?"),
      "Help me understand replication tradeoffs",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(
        "Aria couldn't tailor follow-up questions this time. You can still search from your request.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Find sources" }));
    await waitFor(() => expect(onDiscover).toHaveBeenCalledTimes(1));
  });
});

describe("AddSourcesDialog interview uploads", () => {
  it("binds an uploaded replacement CV to the originating interview activity", async () => {
    const user = userEvent.setup();
    const source = {
      originalName: "updated-cv.txt",
      storedName: "updated-cv.txt",
      extractedName: null,
      mimeType: "text/plain",
      size: 24,
      approxWords: 4,
    };
    const interview: ProjectActivity = {
      id: "activity-1",
      kind: "interview",
      title: "Backend engineer interview",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      messageCount: 0,
      setupComplete: true,
      interview: { role: "Backend engineer", company: null },
    };
    const uploadedNotebook: Notebook = {
      id: "project-1",
      title: "Backend roles",
      goal: "Prepare for backend roles",
      sourceFiles: [source],
      activities: [interview],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:01.000Z",
      archivedAt: null,
    };
    const reboundNotebook: Notebook = {
      ...uploadedNotebook,
      updatedAt: "2026-07-29T00:00:02.000Z",
    };
    vi.spyOn(api, "addSources").mockResolvedValue({
      notebook: uploadedNotebook,
      added: [source],
      warnings: [],
    });
    vi.spyOn(api, "updateActivity").mockResolvedValue({
      activity: interview,
      notebook: reboundNotebook,
    });
    const onAdded = vi.fn();
    const { container } = render(
      <SnackbarProvider>
        <AddSourcesDialog
          open
          notebookId="project-1"
          activityId="activity-1"
          interview
          discovering={false}
          kickoffRunning={false}
          intakePending={false}
          initialMode="upload"
          onClose={() => {}}
          onAdded={onAdded}
          onDiscover={async () => {}}
        />
      </SnackbarProvider>,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input!, new File(["updated cv"], "updated-cv.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "This is my updated CV" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(api.updateActivity).toHaveBeenCalledWith("project-1", "activity-1", {
        cvSource: "updated-cv.txt",
      }),
    );
    expect(onAdded).toHaveBeenCalledWith(reboundNotebook);
  });
});
