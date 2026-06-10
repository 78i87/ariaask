import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../../components/Icon";
import type { ChatMessage } from "../../lib/types";
import "./MessageBubble.css";

export function StudentAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`student-avatar${pulsing ? " student-avatar--pulsing" : ""}`}>
      <Icon name="school" size={18} />
    </div>
  );
}

// Memoized so finalized bubbles (stable message reference) don't re-render on
// every streaming flush; only the actively-streaming bubble updates.
export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "teacher") {
    return (
      <div className="msg msg--teacher">
        <div className="msg__bubble msg__bubble--teacher body-large">{message.text}</div>
      </div>
    );
  }
  const streaming = message.status === "streaming";
  return (
    <div className="msg msg--student">
      <StudentAvatar pulsing={streaming} />
      <div className={`msg__bubble msg__bubble--student body-large${streaming ? " msg__bubble--streaming" : ""}`}>
        {/* Render plain text while streaming (avoids re-parsing partial markdown each frame); parse once on completion. */}
        {streaming ? (
          <span className="msg__streaming-text">{message.text}</span>
        ) : (
          <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
        )}
        {streaming && <span className="msg__cursor" />}
        {message.interrupted && <div className="msg__interrupted body-medium">interrupted</div>}
      </div>
    </div>
  );
});
