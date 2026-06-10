import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { TopAppBar } from "../components/TopAppBar";
import { useTheme } from "../lib/theme";
import { useTeachingSession } from "../lib/useTeachingSession";
import { Composer } from "./session/Composer";
import { MessageBubble } from "./session/MessageBubble";
import { ThinkingIndicator } from "./session/ThinkingIndicator";
import { SettingsDialog } from "./settings/SettingsDialog";
import "./SessionView.css";

const PIN_THRESHOLD = 80;

export function SessionView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const session = useTeachingSession(id!);
  const { notebook, messages, status, kickoffRunning, activity, error, send, interrupt, retry } = session;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
    setShowJump(!pinnedRef.current && (status === "streaming" || status === "waiting"));
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: status === "streaming" ? "auto" : "smooth" });
  }, [messages, status]);

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

  const busy = status === "waiting" || status === "streaming";
  const waitingLabel = kickoffRunning
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
            <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} ariaLabel="Toggle theme" onClick={toggle} />
            <IconButton icon="settings" ariaLabel="Settings" onClick={() => setSettingsOpen(true)} />
          </>
        }
        scrollContainer={scrollerRef.current}
      />

      {notebook && (
        <div className="session__chips">
          {notebook.type === "topic" ? (
            <Chip icon="menu_book" label={notebook.topic ?? notebook.title} />
          ) : (
            notebook.sourceFiles.map((f) => (
              <Chip key={f.storedName} icon="description" label={f.originalName} />
            ))
          )}
        </div>
      )}

      <div className="session__scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="session__thread">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
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

      <Composer
        disabled={status === "loading" || status === "error" || kickoffRunning}
        busy={busy}
        onSend={send}
        onStop={interrupt}
      />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
