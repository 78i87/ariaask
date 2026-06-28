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
import { useSplitChat } from "../lib/splitChat";
import { useTheme } from "../lib/theme";
import { useCyraThreads } from "../lib/useCyraThread";
import { useMediaQuery } from "../lib/useMediaQuery";
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
import { CyraChips, ThreadBar } from "./session/ThreadBar";
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
    knowledgeState,
    notice,
    discovering,
    ragBuilding,
    ragBuildFailed,
    clearNotice,
    submitIntake,
    discoverSources,
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
  /** Sources panel collapse — an app-level preference, remembered across notebooks. */
  const [sourcesCollapsed, setSourcesCollapsed] = useState(() => localStorage.getItem("aria-sources-collapsed") === "1");
  const toggleSources = (collapsed: boolean) => {
    setSourcesCollapsed(collapsed);
    localStorage.setItem("aria-sources-collapsed", collapsed ? "1" : "0");
  };
  const snackbar = useSnackbar();

  // ---- "Ask Cyra" expert threads ----
  const [activeThread, setActiveThread] = useState<ThreadSelection>({ kind: "aria" });
  /** Unsent new-question draft; non-null while the provisional chip exists. */
  const [newDraft, setNewDraft] = useState<string | null>(null);
  const [seedSourceMessageId, setSeedSourceMessageId] = useState<string | null>(null);
  const { threads: cyraThreads, loaded: cyraLoaded, refresh: refreshCyraThreads } = useCyraThreads(id!);

  // ---- split chat (Aria left, Cyra right) ----
  const splitChat = useSplitChat();
  // Below this the sources panel is gone too — not enough room for two chats.
  const wideEnough = useMediaQuery("(min-width: 1141px)");
  const splitActive = splitChat && wideEnough;
  const splitActiveRef = useRef(splitActive);
  splitActiveRef.current = splitActive;
  /** Right-pane thread: undefined = follow the newest thread, null = new question. */
  const [splitCyraId, setSplitCyraId] = useState<string | null | undefined>(undefined);
  /**
   * Pending "Ask Cyra" question bound for the right pane's EXISTING thread.
   * Deliberately separate from newDraft (the new-question composer's text) so
   * an unsent new question can never leak into another conversation.
   */
  const [askDraft, setAskDraft] = useState<string | null>(null);
  /** Bumped per "Ask Cyra" so the split pane merges/focuses exactly once. */
  const [askSeq, setAskSeq] = useState(0);
  const splitThreadId = splitCyraId === undefined ? (cyraThreads[0]?.id ?? null) : splitCyraId;
  const splitThreadIdRef = useRef(splitThreadId);
  splitThreadIdRef.current = splitThreadId;

  // Entering split mode while a Cyra tab is open: that conversation moves to
  // the right pane and the left pane returns to Aria. A render-phase
  // adjustment rather than an effect so the in-between state never commits —
  // no right-pane fetch of the wrong thread, no unscrolled Aria frame.
  if (splitActive && activeThread.kind === "cyra") {
    setSplitCyraId(activeThread.threadId);
    setActiveThread({ kind: "aria" });
  }

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
    const question = extractTrailingQuestion(m.text);
    // Split mode: the question lands in the right-hand Cyra pane — merged into
    // the open conversation's composer, or as the new-question draft when the
    // notebook has no Cyra conversations yet.
    if (splitActiveRef.current) {
      if (splitThreadIdRef.current !== null) {
        setAskDraft(question);
      } else {
        setNewDraft(question);
        setSeedSourceMessageId(m.id);
        // Pin the right pane to the new-question view. Before the thread list
        // loads, splitThreadId reads null even when threads exist — without
        // the pin the pane would switch to the newest thread once they arrive
        // and hide this draft.
        setSplitCyraId(null);
      }
      setAskSeq((s) => s + 1);
      return;
    }
    setNewDraft(question);
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
    setSplitCyraId(undefined);
    setAskDraft(null);
    beforeMapRef.current = { kind: "aria" };
  }, [id]);

  const onSelectThread = useCallback((sel: ThreadSelection) => {
    // Split mode: Cyra chips switch the right pane, not the main view.
    if (splitActiveRef.current && sel.kind === "cyra") {
      setSplitCyraId(sel.threadId);
      setAskDraft(null); // a pending ask must not follow to another conversation
      return;
    }
    setActiveThread(sel);
  }, []);

  // The knowledge map is a full-panel overlay state: the app-bar chip toggles
  // it, remembering the view underneath (Esc gets back out too).
  const beforeMapRef = useRef<ThreadSelection>({ kind: "aria" });
  const mapOpen = activeThread.kind === "map";
  const toggleMap = () => {
    if (mapOpen) {
      // If the remembered view was a Cyra tab and split mode took over since,
      // the render-phase adjustment above reroutes it to the right pane.
      setActiveThread(beforeMapRef.current);
    } else {
      beforeMapRef.current = activeThread;
      setActiveThread({ kind: "map" });
    }
  };
  useEffect(() => {
    if (!mapOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // An open dialog owns Esc (the browser closes it on this same keydown).
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        setActiveThread(beforeMapRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapOpen]);

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
      ? "Aria is finding readings online…"
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
            <Chip
              icon="hub"
              label="Your knowledge map"
              selected={mapOpen}
              onClick={toggleMap}
              className="session__map-chip"
            />
            <IconButton
              icon="add"
              ariaLabel="Add sources"
              disabled={status === "loading"}
              onClick={() => setAddOpen(true)}
            />
            <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} ariaLabel="Toggle theme" onClick={toggle} />
            {notebook && (notebook.sourceFiles.length > 0 || discovering) && (
              <span className="session__panel-toggle-slot">
                <IconButton
                  icon={sourcesCollapsed ? "right_panel_open" : "right_panel_close"}
                  ariaLabel={sourcesCollapsed ? "Show sources panel" : "Hide sources panel"}
                  onClick={() => toggleSources(!sourcesCollapsed)}
                />
              </span>
            )}
            <IconButton icon="settings" ariaLabel="Settings" onClick={() => setSettingsOpen(true)} />
          </>
        }
        scrollContainer={scrollerRef.current}
      />

      <div className="session__body">
        <div className="session__content">
          {/* Full-screen map: no thread switcher — the app-bar chip / Esc exit. */}
          {!mapOpen && (
            <ThreadBar active={activeThread} threads={cyraThreads} onSelect={onSelectThread} split={splitActive} />
          )}

          {notebook && (notebook.sourceFiles.length > 0 || discovering) && (
            <div className="session__chips">
              {notebook.sourceFiles.map((f) => (
                <Chip key={f.storedName} icon={sourceIcon(f)} label={f.originalName} onClick={() => setPreview(f)} />
              ))}
              {discovering && <Chip icon="travel_explore" label="Finding sources…" />}
            </div>
          )}

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
          knowledgeState ? (
            <KnowledgeMapView state={knowledgeState} />
          ) : (
            <div className="session__main">
              <EmptyState
                icon="hub"
                headline="No map yet"
                body="Your knowledge map appears here once Aria has a concept graph for the session."
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
        </div>

        {/* The knowledge map always gets the full panel — the Cyra pane steps
            aside while the map is open and returns with the Aria pane. */}
        {splitActive && activeThread.kind !== "map" && (
          <div className="session__split">
            {/* Until the thread list settles we can't know the default thread —
                rendering the new-question view here would flash and refetch. */}
            {cyraLoaded && (
              <>
                <div className="threadbar threadbar--split">
                  <div className="threadbar__scroll">
                    <CyraChips
                      selected={{ threadId: splitThreadId }}
                      threads={cyraThreads}
                      onSelect={(threadId) => onSelectThread({ kind: "cyra", threadId })}
                    />
                  </div>
                </div>
                <CyraThreadView
                  notebookId={id!}
                  threadId={splitThreadId}
                  draft={newDraft ?? ""}
                  onDraftChange={setNewDraft}
                  sourceMessageId={seedSourceMessageId}
                  askDraft={askDraft}
                  askSeq={askSeq}
                  onAskDraftConsumed={() => setAskDraft(null)}
                  autoFocusNew={false}
                  onThreadCreated={(t) => {
                    setNewDraft(null);
                    setSeedSourceMessageId(null);
                    void refreshCyraThreads();
                    setSplitCyraId(t.id);
                  }}
                  onEdited={() => void refreshCyraThreads()}
                />
              </>
            )}
          </div>
        )}

        {notebook && (notebook.sourceFiles.length > 0 || discovering) && (
          <div className={`session__sources-wrap${sourcesCollapsed ? " session__sources-wrap--closed" : ""}`}>
            <SourcesPanel
              notebook={notebook}
              discovering={discovering}
              ragBuilding={ragBuilding}
              ragBuildFailed={ragBuildFailed}
              onOpenFile={setPreview}
              onDeleteFile={setDeleteTarget}
            />
          </div>
        )}
      </div>

      {preview && notebook && (
        <SourcePreviewDialog notebookId={notebook.id} file={preview} onClose={() => setPreview(null)} />
      )}

      {notebook && (
        <AddSourcesDialog
          open={addOpen}
          notebookId={notebook.id}
          topicSuggestion={notebook.topic ?? notebook.title}
          discovering={discovering}
          kickoffRunning={kickoffRunning}
          intakePending={intakePending}
          onClose={() => setAddOpen(false)}
          onAdded={updateNotebook}
          onDiscover={discoverSources}
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
