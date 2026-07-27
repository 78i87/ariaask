import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { SettingsResponse } from "../../lib/types";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../lib/auth", () => ({
  useAuth: () => ({ state: { phase: "signed-in", email: "teacher@example.com", planType: "pro" }, logout: vi.fn() }),
}));
vi.mock("../../lib/theme", () => ({
  useTheme: () => ({ palette: "blue", setPalette: vi.fn() }),
}));
vi.mock("../../lib/splitChat", () => ({
  useSplitChat: () => false,
  setSplitChat: vi.fn(),
}));

const response: SettingsResponse = {
  settings: { model: "gpt", effort: "high", replyLength: "default" as const, probing: "default" as const, ragMode: "auto" as const, ragRecall: "default" as const },
  models: [{ model: "gpt", displayName: "GPT", description: "Exact technical detail", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ effort: "high", description: "Deep" }] }],
};

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.spyOn(api, "getSettings").mockResolvedValue(response);
    vi.spyOn(api, "updateSettings").mockResolvedValue({ settings: response.settings });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({ currentVersion: "1", latestVersion: "1", updateAvailable: false, installMethod: "npm", canUpdate: true, state: "idle", message: "Current" });
  });

  it("loads CLI status lazily and reports autosave state", async () => {
    const user = userEvent.setup();
    let finishSave: ((value: { settings: typeof response.settings }) => void) | undefined;
    vi.mocked(api.updateSettings).mockImplementation(
      () => new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    render(<SettingsDialog open onClose={() => {}} />);
    expect(await screen.findByText("Exact technical detail")).toBeInTheDocument();
    expect(api.getCodexStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Chatty" }));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    finishSave?.({ settings: { ...response.settings, replyLength: "chatty" } });
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    await user.click(screen.getByRole("radio", { name: "Advanced" }));
    await waitFor(() => expect(api.getCodexStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("keeps the last snapshot visible while a reopen refresh is pending", async () => {
    let finishRefresh: ((value: SettingsResponse) => void) | undefined;
    vi.mocked(api.getSettings)
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );

    const { rerender } = render(<SettingsDialog open onClose={() => {}} />);
    expect(await screen.findByText("Exact technical detail")).toBeInTheDocument();

    rerender(<SettingsDialog open={false} onClose={() => {}} />);
    rerender(<SettingsDialog open onClose={() => {}} />);

    expect(screen.getByText("Exact technical detail")).toBeInTheDocument();
    finishRefresh?.(response);
  });
});
