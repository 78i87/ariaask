import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RichMarkdown, StreamingRichMarkdown } from "./RichMarkdown";

describe("RichMarkdown", () => {
  it("renders GFM emphasis and mathematical notation", () => {
    const { container } = render(<RichMarkdown>{"**Monthly rate** is $r / 12$."}</RichMarkdown>);
    expect(container.querySelector("strong")).toHaveTextContent("Monthly rate");
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders settled streaming paragraphs and leaves only the live tail plain", () => {
    const { container } = render(
      <StreamingRichMarkdown>{"**Settled** paragraph.\n\nStill **typing"}</StreamingRichMarkdown>,
    );
    expect(container.querySelector("strong")).toHaveTextContent("Settled");
    expect(container.querySelector(".streaming-markdown__tail")).toHaveTextContent("Still **typing");
  });
});
