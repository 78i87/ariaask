import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { useCoachThread } from "../../lib/useCoachThread";
import type { CoachChatMessage } from "../../lib/types";
import { Composer } from "../session/Composer";
import { ThinkingIndicator } from "../session/ThinkingIndicator";
import "./CoachChatView.css";

export function CoachAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`coach-avatar${pulsing ? " coach-avatar--pulsing" : ""}`}>
      <Icon name="psychology" size={18} />
    </div>
  );
}

interface CoachBubbleProps {
  message: CoachChatMessage;
  onCopy: (m: CoachChatMessage) => void;
  /** Rewind-and-resend edit; user messages only. */
  onEdit: (m: CoachChatMessage) => void;
}

function CoachBubble({ message, onCopy, onEdit }: CoachBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="msg msg--teacher">
        <div className="msg__col msg__col--teacher">
          <div className="msg__bubble msg__bubble--coach-user body-large">{message.text}</div>
          <div className="msg__actions">
            <button type="button" className="msg-action" onClick={() => onCopy(message)}>
              <Icon name="content_copy" size={16} />
              <span className="label-medium">Copy</span>
            </button>
            <button type="button" className="msg-action" onClick={() => onEdit(message)}>
              <Icon name="edit" size={16} />
              <span className="label-medium">Edit</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
  const streaming = message.status === "streaming";
  return (
    <div className="msg msg--student">
      <CoachAvatar pulsing={streaming} />
      <div className="msg__col">
        <div className="msg__bubble msg__bubble--student msg__bubble--coach body-large">
          {streaming ? (
            <span className="msg__streaming-text">{message.text}</span>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
          )}
          {streaming && <span className="msg__cursor" />}
          {message.interrupted && <div className="msg__interrupted body-medium">interrupted</div>}
        </div>
        {!streaming && (
          <div className="msg__actions">
            <button type="button" className="msg-action" onClick={() => onCopy(message)}>
              <Icon name="content_copy" size={16} />
              <span className="label-medium">Copy</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The coach conversation for one learning project — the main pane of the
 * coach shell. A lean sibling of CyraThreadView: same scroll pinning, same
 * edit-rewind affordance, no create-on-first-send (the coach kickoff greets
 * the user instead, driven by useCoachThread).
 */
export function CoachChatView({ notebookId }: { notebookId: string }) {
  const { messages, status, activity, error, send, editMessage, interrupt, retry } = useCoachThread(notebookId);
  /** Rewind-and-resend edit: the message being edited + its draft text. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const snackbar = useSnackbar();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    setEditing(null); // an edit drafted for one project must not leak into another
  }, [notebookId]);

  const onCopy = (m: CoachChatMessage) => {
    navigator.clipboard.writeText(m.text).then(
      () => snackbar.show("Copied"),
      () => snackbar.show("Couldn't copy"),
    );
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [messages, status]);

  const busy = status === "waiting" || status === "streaming";
  const waitingLabel = activity === "reading-sources" ? "The coach is checking your materials…" : undefined;

  return (
    <div className="coach-chat">
      <div className="session__scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="session__thread">
          {status === "loading" && messages.length === 0 ? (
            <div className="coach-chat__loading">
              <ProgressIndicator />
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <CoachBubble
                  key={m.id}
                  message={m}
                  onCopy={onCopy}
                  onEdit={(msg) => setEditing({ id: msg.id, text: msg.text })}
                />
              ))}

              {status === "waiting" && <ThinkingIndicator avatar={<CoachAvatar pulsing />} label={waitingLabel} />}

              {status === "error" && (
                <div className="session__error">
                  <Icon name="error" size={18} className="session__error-icon" />
                  <span className="body-medium">{error ?? "The coach lost their train of thought."}</span>
                  <Button variant="text" onClick={retry}>
                    Retry
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="session__editing">
          <Icon name="edit" size={16} />
          <span className="body-medium">Editing — sending rewinds this conversation past this point</span>
          <Button variant="text" onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </div>
      )}
      <Composer
        key={editing ? `edit:${editing.id}` : "normal"}
        disabled={status === "loading"}
        busy={busy}
        onSend={
          editing
            ? (text) => {
                editMessage(editing.id, text);
                setEditing(null);
              }
            : send
        }
        onStop={interrupt}
        placeholder="Ask your coach — what to learn next, or how…"
        {...(editing
          ? {
              value: editing.text,
              onChange: (t: string) => setEditing((p) => (p ? { ...p, text: t } : p)),
              autoFocus: true,
            }
          : {})}
      />
    </div>
  );
}
