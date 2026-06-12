import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import { useCyraThread } from "../../lib/useCyraThread";
import type { CyraChatMessage, CyraThreadSummary } from "../../lib/types";
import { Composer } from "./Composer";
import { ThinkingIndicator } from "./ThinkingIndicator";
import "./CyraThreadView.css";

export function CyraAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`cyra-avatar${pulsing ? " cyra-avatar--pulsing" : ""}`}>
      <Icon name="history_edu" size={18} />
    </div>
  );
}

interface CyraBubbleProps {
  message: CyraChatMessage;
  onCopy?: (m: CyraChatMessage) => void;
  /** Rewind-and-resend edit; user messages only. */
  onEdit?: (m: CyraChatMessage) => void;
}

function CyraBubble({ message, onCopy, onEdit }: CyraBubbleProps) {
  if (message.role === "user") {
    const showActions = onCopy !== undefined || onEdit !== undefined;
    return (
      <div className="msg msg--teacher">
        <div className="msg__col msg__col--teacher">
          <div className="msg__bubble msg__bubble--cyra-user body-large">{message.text}</div>
          {showActions && (
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
  return (
    <div className="msg msg--student">
      <CyraAvatar pulsing={streaming} />
      <div className="msg__col">
        <div className={`msg__bubble msg__bubble--student msg__bubble--cyra body-large`}>
          {streaming ? (
            <span className="msg__streaming-text">{message.text}</span>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
          )}
          {streaming && <span className="msg__cursor" />}
          {message.interrupted && <div className="msg__interrupted body-medium">interrupted</div>}
        </div>
        {!streaming && onCopy && (
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

interface CyraThreadViewProps {
  notebookId: string;
  /** null = the new-question view (draft composer, thread created on first send). */
  threadId: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  sourceMessageId: string | null;
  onThreadCreated: (thread: CyraThreadSummary) => void;
  /** Called after a successful edit (the seed edit re-derives the thread title). */
  onEdited?: () => void;
  /**
   * Split-chat mode: each "Ask Cyra" click bumps askSeq; if askDraft is set,
   * the question is merged into this thread's follow-up composer (appended,
   * never replacing typed text) and consumed; either way the composer is
   * focused. Tabbed mode never passes these.
   */
  askDraft?: string | null;
  askSeq?: number;
  onAskDraftConsumed?: () => void;
  /** Off for the always-mounted split pane: mounting must not steal focus. */
  autoFocusNew?: boolean;
}

/**
 * One "Ask Cyra" conversation: the user is the student here, Cyra the expert
 * teacher — visually unmistakable via the tertiary color family, its own
 * avatar, and the banner.
 */
export function CyraThreadView({
  notebookId,
  threadId,
  draft,
  onDraftChange,
  sourceMessageId,
  onThreadCreated,
  onEdited,
  askDraft = null,
  askSeq = 0,
  onAskDraftConsumed,
  autoFocusNew = true,
}: CyraThreadViewProps) {
  const { messages, status, activity, error, send, editMessage, interrupt, retry } = useCyraThread(
    notebookId,
    threadId,
  );
  /** The seed text while the create-on-first-send POST is in flight. */
  const [creating, setCreating] = useState<string | null>(null);
  /** Rewind-and-resend edit: the message being edited + its draft text. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** The follow-up composer's text — controlled so "Ask Cyra" can merge into it. */
  const [followUp, setFollowUp] = useState("");
  /** Composer focus requests (each "Ask Cyra" bumps it via the effect below). */
  const [focusBump, setFocusBump] = useState(0);
  const snackbar = useSnackbar();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const isNew = threadId === null;

  useEffect(() => {
    setEditing(null);
    setFollowUp(""); // a follow-up typed for one conversation must not leak into another
  }, [threadId]);

  // An "Ask Cyra" click landed here: cancel any edit (a fresh ask wins the
  // composer), append the question to whatever was already typed, and focus.
  // For the new-question view the parent put the text in `draft` instead —
  // only the focus applies.
  const askSeqSeen = useRef(askSeq);
  useEffect(() => {
    if (askSeq === askSeqSeen.current) return;
    askSeqSeen.current = askSeq;
    setEditing(null);
    if (!isNew && askDraft !== null) {
      setFollowUp((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${askDraft}` : askDraft));
      onAskDraftConsumed?.();
    }
    setFocusBump((k) => k + 1);
  }, [askSeq, askDraft, isNew, onAskDraftConsumed]);

  const onCopy = (m: CyraChatMessage) => {
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
  }, [messages, status, creating]);

  const createThread = (text: string) => {
    setCreating(text);
    void api
      .createCyraThread(notebookId, {
        text,
        clientMessageId: crypto.randomUUID(),
        sourceMessageId: sourceMessageId ?? undefined,
      })
      .then((res) => {
        setCreating(null);
        onThreadCreated(res.thread);
      })
      .catch((err) => {
        setCreating(null);
        onDraftChange(text); // the composer cleared on send — restore the draft
        snackbar.show(err instanceof Error ? err.message : "Couldn't reach Cyra");
      });
  };

  const busy = !isNew && (status === "waiting" || status === "streaming");
  const waitingLabel = activity === "reading-sources" ? "Cyra is checking the reading…" : undefined;

  return (
    <div className="session__main cyra-view">
      <div className="session__scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="session__thread">
          <div className="cyra-banner">
            <CyraAvatar />
            <div className="cyra-banner__text">
              <span className="cyra-banner__headline title-small">You're asking Cyra</span>
              <span className="body-medium">
                An expert teacher who has read your sources. Each conversation is rooted in one question — ask
                follow-ups freely.
              </span>
            </div>
          </div>

          {isNew ? (
            creating !== null && (
              <>
                <CyraBubble message={{ id: "creating", role: "user", text: creating, status: "complete" }} />
                <ThinkingIndicator avatar={<CyraAvatar pulsing />} />
              </>
            )
          ) : (
            <>
              {messages.map((m) => (
                <CyraBubble key={m.id} message={m} onCopy={onCopy} onEdit={(msg) => setEditing({ id: msg.id, text: msg.text })} />
              ))}

              {status === "waiting" && <ThinkingIndicator avatar={<CyraAvatar pulsing />} label={waitingLabel} />}

              {status === "error" && (
                <div className="session__error">
                  <Icon name="error" size={18} className="session__error-icon" />
                  <span className="body-medium">{error ?? "Cyra lost her train of thought."}</span>
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
        key={isNew ? "new" : editing ? `edit:${editing.id}` : "normal"}
        disabled={isNew ? creating !== null : status === "loading" || status === "error"}
        busy={busy}
        onSend={
          isNew
            ? createThread
            : editing
              ? (text) => {
                  editMessage(editing.id, text, onEdited);
                  setEditing(null);
                }
              : send
        }
        onStop={interrupt}
        placeholder="Ask Cyra, your expert teacher…"
        accent="tertiary"
        autoFocus={isNew && autoFocusNew}
        focusKey={focusBump}
        {...(isNew
          ? { value: draft, onChange: onDraftChange }
          : editing
            ? {
                value: editing.text,
                onChange: (t: string) => setEditing((p) => (p ? { ...p, text: t } : p)),
                autoFocus: true,
              }
            : { value: followUp, onChange: setFollowUp })}
      />
    </div>
  );
}
