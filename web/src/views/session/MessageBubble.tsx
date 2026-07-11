import { memo } from "react";
import { Icon } from "../../components/Icon";
import { RichMarkdown, StreamingRichMarkdown } from "../../components/RichMarkdown";
import type { ChatMessage } from "../../lib/types";
import "./MessageBubble.css";

export function StudentAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`student-avatar${pulsing ? " student-avatar--pulsing" : ""}`}>
      <Icon name="school" size={18} />
    </div>
  );
}

export function CyraAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`cyra-avatar${pulsing ? " cyra-avatar--pulsing" : ""}`}>
      <Icon name="history_edu" size={18} />
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** Interview mode: student-role messages are Cyra the interviewer (avatar + tertiary tint). */
  interviewer?: boolean;
  /** All handlers must be deps-stable callbacks — this component is memo'd. */
  onCopy?: (m: ChatMessage) => void;
  onAskCyra?: (m: ChatMessage) => void;
  /** Rewind-and-resend edit; teacher messages only. */
  onEdit?: (m: ChatMessage) => void;
}

// Memoized so finalized bubbles (stable message reference) don't re-render on
// every streaming flush; only the actively-streaming bubble updates.
export const MessageBubble = memo(function MessageBubble({
  message,
  interviewer,
  onCopy,
  onAskCyra,
  onEdit,
}: MessageBubbleProps) {
  if (message.role === "teacher") {
    const showTeacherActions = onCopy !== undefined || onEdit !== undefined;
    return (
      <div className="msg msg--teacher">
        <div className="msg__col msg__col--teacher">
          <div className="msg__bubble msg__bubble--teacher body-large">{message.text}</div>
          {showTeacherActions && (
            <div className="msg__actions">
              {onCopy && (
                <button type="button" className="msg-action" onClick={() => onCopy(message)}>
                  <Icon name="content_copy" size={16} />
                  <span className="label-medium">Copy</span>
                </button>
              )}
              {onEdit && (
                <button type="button" className="msg-action" onClick={() => onEdit(message)}>
                  <Icon name="edit" size={16} />
                  <span className="label-medium">Edit</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  const streaming = message.status === "streaming";
  const showActions = !streaming && (onCopy !== undefined || onAskCyra !== undefined);
  return (
    <div className="msg msg--student">
      {interviewer ? <CyraAvatar pulsing={streaming} /> : <StudentAvatar pulsing={streaming} />}
      <div className="msg__col">
        <div
          className={`msg__bubble msg__bubble--student${interviewer ? " msg__bubble--cyra" : ""} body-large${streaming ? " msg__bubble--streaming" : ""}`}
        >
          {streaming ? (
            <StreamingRichMarkdown>{message.text}</StreamingRichMarkdown>
          ) : (
            <RichMarkdown>{message.text}</RichMarkdown>
          )}
          {streaming && <span className="msg__cursor" />}
          {message.interrupted && <div className="msg__interrupted body-medium">interrupted</div>}
        </div>
        {showActions && (
          <div className="msg__actions">
            {onCopy && (
              <button type="button" className="msg-action" onClick={() => onCopy(message)}>
                <Icon name="content_copy" size={16} />
                <span className="label-medium">Copy</span>
              </button>
            )}
            {onAskCyra && (
              <button type="button" className="msg-action msg-action--cyra" onClick={() => onAskCyra(message)}>
                <Icon name="history_edu" size={16} />
                <span className="label-medium">Ask Cyra</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
