import { memo } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "./RichMarkdown.css";

interface RichMarkdownProps {
  children: string;
  className?: string;
}

export const RichMarkdown = memo(function RichMarkdown({ children, className }: RichMarkdownProps) {
  return (
    <div className={`rich-markdown${className ? ` ${className}` : ""}`}>
      <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {children}
      </Markdown>
    </div>
  );
});

/** Renders completed paragraphs richly while keeping the live tail cheap and stable. */
export const StreamingRichMarkdown = memo(function StreamingRichMarkdown({ children, className }: RichMarkdownProps) {
  const boundary = children.lastIndexOf("\n\n");
  const settled = boundary >= 0 ? children.slice(0, boundary) : "";
  const tail = boundary >= 0 ? children.slice(boundary + 2) : children;
  return (
    <div className={`streaming-markdown${className ? ` ${className}` : ""}`}>
      {settled && <RichMarkdown>{settled}</RichMarkdown>}
      {tail && <span className="streaming-markdown__tail">{tail}</span>}
    </div>
  );
});
