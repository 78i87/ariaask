import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { TopAppBar } from "../components/TopAppBar";
import { useSnackbar } from "../components/Snackbar";
import { api } from "../lib/api";
import { extractTrailingQuestion } from "../lib/extractQuestion";
import { useTheme } from "../lib/theme";
import { useCyraThreads } from "../lib/useCyraThread";
import { useTeachingSession } from "../lib/useTeachingSession";
import type { ChatMessage, SourceFile, ThreadSelection } from "../lib/types";
import { AddSourcesDialog } from "./session/AddSourcesDialog";
import { Composer } from "./session/Composer";
import { CyraThreadView } from "./session/CyraThreadView";
import { IntakeForm } from "./session/IntakeForm";
import { KnowledgeMapView } from "./session/KnowledgeMapView";
import { MessageBubble } from "./session/MessageBubble";
import { SourcePreviewDialog } from "./session/SourcePreviewDialog";
import { sourceIcon, SourcesPanel } from "./session/SourcesPanel";
import { ThinkingIndicator } from "./session/ThinkingIndicator";
import { ThreadBar } from "./session/ThreadBar";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./SessionView.css";

const PIN_THRESHOLD = 80;

export function SessionView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const session = useTeachingSession(id!);
  const {
    notebook,
    messages,
    status,
    kickoffRunning,
    activity,
    error,
    intake,
    learningState,
    notice,
    clearNotice,
    submitIntake,
    send,
    editMessage,
    interrupt,
    retry,
    updateNotebook,
  } = session;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const didInitialScroll = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [preview, setPreview] = useState<SourceFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const snackbar = useSnackbar();

  // ---- "Ask Cyra" expert threads ----
  const [activeThread, setActiveThread] = useState<ThreadSelection>({ kind: "aria" });
  /** Unsent new-question draft; non-null while the provisional chip exists. */
  const [newDraft, setNewDraft] = useState<string | null>(null);
  const [seedSourceMessageId, setSeedSourceMessageId] = useState<string | null>(null);
  const { threads: cyraThreads, refresh: refreshCyraThreads } = useCyraThreads(id!);

  // The snackbar context value isn't referentially stable; route through a ref
  // so the bubble action callbacks below stay deps-[] (MessageBubble is memo'd).
  const snackbarRef = useRef(snackbar);
  snackbarRef.current = snackbar;

  const onCopyMessage = useCallback((m: ChatMessage) => {
    navigator.clipboard.writeText(m.text).then(
      () => snackbarRef.current.show("Copied"),
      () => snackbarRef.current.show("Couldn't copy"),
    );
  }, []);

  const onAskCyra = useCallback((m: ChatMessage) => {
    setNewDraft(extractTrailingQuestion(m.text));
    setSeedSourceMessageId(m.id);
    setActiveThread({ kind: "cyra", threadId: null });
  }, []);

  /** Rewind-and-resend edit: the message being edited + its draft text. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const onEditMessage = useCallback((m: ChatMessage) => {
    setEditing({ id: m.id, text: m.text });
  }, []);

  const confirmDeleteSource = async () => {
    const target = deleteTarget;
    if (!target || !notebook || deleting) return;
    setDeleting(true);
    try {
      const res = await api.deleteSource(notebook.id, target.storedName);
      updateNotebook(res.notebook);
      setDeleteTarget(null);
      snackbar.show(`Removed "${target.originalName}"`);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Couldn't remove the file");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    didInitialScroll.current = false;
    pinnedRef.current = true;
    setActiveThread({ kind: "aria" });
    setNewDraft(null);
    setSeedSourceMessageId(null);
    setEditing(null);
  }, [id]);

  // Returning to the teaching pane remounts its scroller — re-pin instantly.
  // Must be a LAYOUT effect declared before the scroll effect below: layout
  // effects run in declaration order, while a passive effect would run after
  // it and leave it reading the flags from before the pane switch (stranding
  // the view at the top, or smooth-scrolling the whole transcript).
  useLayoutEffect(() => {
    if (activeThread.kind === "aria") {
      didInitialScroll.current = false;
      pinnedRef.current = true;
    }
  }, [activeThread]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
    setShowJump(!pinnedRef.current && (status === "streaming" || status === "waiting"));
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    // Jump instantly on the first render of the transcript — a smooth scroll
    // here gets cancelled by late layout shifts (font loads) and strands the
    // view at the top. Smooth is only for follow-up messages.
    const instant = status === "streaming" || !didInitialScroll.current;
    el.scrollTo({ top: el.scrollHeight, behavior: instant ? "auto" : "smooth" });
    if (messages.length > 0) didInitialScroll.current = true;
  }, [messages, status, activeThread]);

  useEffect(() => {
    if (status !== "streaming" && status !== "waiting") setShowJump(false);
  }, [status]);

  const jumpToLatest = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Non-fatal server notices (e.g. research failed) surface as snackbars.
  useEffect(() => {
    if (notice) {
      snackbar.show(notice);
      clearNotice();
    }
  }, [notice, clearNotice, snackbar]);

  const intakePending = intake !== null && intake.status === "pending" && messages.length === 0;
  const busy = status === "waiting" || status === "streaming";
  const waitingLabel =
    activity === "researching"
      ? "Aria is reading up online…"
      : kickoffRunning
        ? activity === "reading-sources"
          ? "Aria is doing the reading…"
          : "Aria is getting ready…"
        : undefined;

  return (
    <div className="session">
      <TopAppBar
        leading={<IconButton icon="arrow_back" ariaLabel="Back to notebooks" onClick={() => navigate("/")} />}
        headline={<span className="title-large">{notebook?.title ?? ""}</span>}
        trailing={
          <>
            <IconButton
              icon="add"
              ariaLabel="Add sources"
              disabled={status === "loading"}
              onClick={() => setAddOpen(true)}
            />
            <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} ariaLabel="Toggle theme" onClick={toggle} />
            <IconButton icon="settings" ariaLabel="Settings" onClick={() => setSettingsOpen(true)} />
          </>
        }
        scrollContainer={scrollerRef.current}
      />

      <ThreadBar active={activeThread} threads={cyraThreads} onSelect={setActiveThread} />

      {notebook && notebook.sourceFiles.length > 0 && (
        <div className="session__chips">
          {notebook.sourceFiles.map((f) => (
            <Chip key={f.storedName} icon={sourceIcon(f)} label={f.originalName} onClick={() => setPreview(f)} />
          ))}
        </div>
      )}

      <div className="session__body">
        {activeThread.kind === "aria" ? (
          <div className="session__main">
            <div className="session__scroller" ref={scrollerRef} onScroll={onScroll}>
              <div className="session__thread">
                {intakePending && status !== "loading" && (
                  <IntakeForm
                    questions={intake.questions}
                    submitting={false}
                    onSubmit={(answers) => submitIntake({ answers })}
                    onSkip={() => submitIntake({ skip: true })}
                  />
                )}

                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    onCopy={onCopyMessage}
                    onAskCyra={onAskCyra}
                    onEdit={onEditMessage}
                  />
                ))}

                {status === "waiting" && <ThinkingIndicator label={waitingLabel} />}

                {status === "error" && (
                  <div className="session__error">
                    <Icon name="error" size={18} className="session__error-icon" />
                    <span className="body-medium">{error ?? "The student lost their train of thought."}</span>
                    <Button variant="text" onClick={retry}>
                      Retry
                    </Button>
                  </div>
                )}
              </div>

              {showJump && (
                <button type="button" className="session__jump label-large" onClick={jumpToLatest}>
                  <Icon name="arrow_downward" size={18} />
                  Jump to latest
                </button>
              )}
            </div>

            {editing && (
              <div className="session__editing">
                <Icon name="edit" size={16} />
                <span className="body-medium">Editing — sending rewinds the conversation past this point</span>
                <Button variant="text" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            )}
            <Composer
              key={editing ? `edit:${editing.id}` : "normal"}
              disabled={status === "loading" || status === "error" || kickoffRunning || intakePending}
              busy={busy}
              onSend={(text) => {
                if (editing) {
                  editMessage(editing.id, text);
                  setEditing(null);
                } else {
                  send(text);
                }
              }}
              onStop={interrupt}
              {...(editing
                ? {
                    value: editing.text,
                    onChange: (t: string) => setEditing((p) => (p ? { ...p, text: t } : p)),
                    autoFocus: true,
                  }
                : {})}
            />
          </div>
        ) : activeThread.kind === "map" ? (
          learningState ? (
            <KnowledgeMapView state={learningState} />
          ) : (
            <div className="session__main">
              <EmptyState
                icon="hub"
                headline="No map yet"
                body="Aria's map of the topic appears here once she has her starting picture — right after the session gets going."
              />
            </div>
          )
        ) : (
          <CyraThreadView
            notebookId={id!}
            threadId={activeThread.threadId}
            draft={newDraft ?? ""}
            onDraftChange={setNewDraft}
            sourceMessageId={seedSourceMessageId}
            onThreadCreated={(t) => {
              setNewDraft(null);
              setSeedSourceMessageId(null);
              void refreshCyraThreads();
              setActiveThread({ kind: "cyra", threadId: t.id });
            }}
            onEdited={() => void refreshCyraThreads()}
          />
        )}

        {notebook && <SourcesPanel notebook={notebook} onOpenFile={setPreview} onDeleteFile={setDeleteTarget} />}
      </div>

      {preview && notebook && (
        <SourcePreviewDialog notebookId={notebook.id} file={preview} onClose={() => setPreview(null)} />
      )}

      {notebook && (
        <AddSourcesDialog
          open={addOpen}
          notebookId={notebook.id}
          onClose={() => setAddOpen(false)}
          onAdded={updateNotebook}
        />
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        icon="delete"
        headline="Remove this source?"
        actions={
          <>
            <Button variant="text" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button destructive onClick={() => void confirmDeleteSource()} disabled={deleting}>
              Remove
            </Button>
          </>
        }
      >
        <span className="body-medium">
          <strong>{deleteTarget?.originalName}</strong> will be deleted from this notebook and the student won't be
          able to read it anymore.
        </span>
      </Dialog>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
