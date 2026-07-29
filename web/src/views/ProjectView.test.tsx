import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyProjectSources } from "./ProjectView";

afterEach(cleanup);

describe("project source discovery state", () => {
  it("replaces the empty message with progress while discovery is active", () => {
    const { rerender } = render(<EmptyProjectSources discovering={false} />);
    expect(screen.getByText("No sources yet")).toBeInTheDocument();

    rerender(<EmptyProjectSources discovering />);
    expect(screen.queryByText("No sources yet")).not.toBeInTheDocument();
    expect(screen.getByText("Finding sources…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});
