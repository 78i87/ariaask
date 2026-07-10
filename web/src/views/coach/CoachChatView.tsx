import { isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { annotateTechniques } from "../../lib/techniques";
import { GOAL_PREFIX, WRAP_UP_MESSAGE, CONTINUE_MESSAGE, quickReturnMessage, startTaskMessage } from "../../lib/journeyMessages";
import { TechTerm, TechText } from "./TechTerm";
import { LogEntryCard, parseLog } from "./LogEntryCard";
import { PlanCard, parsePlan } from "./PlanCard";
import { useJourney } from "./journeyContext";
import { useCoachThread, type CoachStatus } from "../../lib/useCoachThread";
import type { CoachChatMessage } from "../../lib/types";
import { MessageContext, useCoachActions, useMessageInfo } from "./coachActions";
import { Composer } from "../session/Composer";
import { ThinkingIndicator } from "../session/ThinkingIndicator";
import "./CoachChatView.css";

// ---------- interactive quiz blocks (```quiz fenced JSON) ----------

interface QuizSpec {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
}

function parseQuiz(source: string): QuizSpec | null {
  try {
    const q = JSON.parse(source) as Partial<QuizSpec>;
    if (
      typeof q.question !== "string" ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      !q.options.every((o) => typeof o === "string") ||
      typeof q.answerIndex !== "number" ||
      q.answerIndex < 0 ||
      q.answerIndex >= q.options.length
    ) {
      return null;
    }
    return q as QuizSpec;
  } catch {
    return null;
  }
}

/** A click-to-answer check-for-understanding card the coach can emit. */
function QuizCard({ quiz }: { quiz: QuizSpec }) {
  const [picked, setPicked] = useState<number | null>(null);
  const answered = picked !== null;
  return (
    <div className="quiz">
      <div className="quiz__question body-large">
        <Icon name="psychology" size={18} />
        {quiz.question}
      </div>
      {quiz.options.map((opt, i) => {
        const state = !answered ? "" : i === quiz.answerIndex ? " quiz__option--correct" : i === picked ? " quiz__option--wrong" : " quiz__option--dim";
        return (
          <button
            key={i}
            type="button"
            className={`quiz__option body-medium${state}`}
            disabled={answered}
            onClick={() => setPicked(i)}
          >
            {answered && i === quiz.answerIndex && <Icon name="check" size={16} />}
            {answered && i === picked && i !== quiz.answerIndex && <Icon name="close" size={16} />}
            {opt}
          </button>
        );
      })}
      {answered && (
        <div className={`quiz__result body-medium${picked === quiz.answerIndex ? " quiz__result--correct" : ""}`}>
          {picked === quiz.answerIndex ? "Right. " : "Not quite. "}
          {quiz.explanation ?? ""}
        </div>
      )}
    </div>
  );
}

// ---------- interactive choice buttons (```choices fenced JSON) ----------

interface ChoiceOption {
  label: string;
  send?: string;
  action?: "upload-sources" | "find-sources";
}

interface ChoicesSpec {
  prompt?: string;
  options: ChoiceOption[];
}

function parseChoices(source: string): ChoicesSpec | null {
  try {
    const c = JSON.parse(source) as Partial<ChoicesSpec>;
    if (!Array.isArray(c.options)) return null;
    const options = c.options.filter(
      (o): o is ChoiceOption =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as ChoiceOption).label === "string" &&
        ((o as ChoiceOption).send === undefined || typeof (o as ChoiceOption).send === "string") &&
        ((o as ChoiceOption).action === undefined ||
          (o as ChoiceOption).action === "upload-sources" ||
          (o as ChoiceOption).action === "find-sources"),
    );
    if (options.length === 0 || options.length > 4) return null;
    return { prompt: typeof c.prompt === "string" ? c.prompt : undefined, options };
  } catch {
    return null;
  }
}

/**
 * Clickable decision buttons the coach can emit. Live only while this is the
 * last coach message and the thread is idle — old blocks deep in the
 * transcript render dimmed and inert.
 */
function ChoicesCard({ choices }: { choices: ChoicesSpec }) {
  const { interactive, send } = useMessageInfo();
  const actions = useCoachActions();
  const [picked, setPicked] = useState<number | null>(null);

  const onPick = (i: number) => {
    if (!interactive || picked !== null) return;
    setPicked(i);
    const opt = choices.options[i]!;
    if (opt.action === "upload-sources") actions.openAddSources();
    else if (opt.action === "find-sources") actions.findSources();
    if (opt.send?.trim()) send(opt.send.trim());
  };

  const inert = !interactive || picked !== null;
  return (
    <div className={`choices${inert ? " choices--inert" : ""}`}>
      {choices.prompt && <div className="choices__prompt body-medium">{choices.prompt}</div>}
      <div className="choices__row">
        {choices.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            className={`choices__option label-large${picked === i ? " choices__option--picked" : ""}`}
            disabled={inert}
            onClick={() => onPick(i)}
          >
            {opt.action === "upload-sources" && <Icon name="upload_file" size={16} />}
            {opt.action === "find-sources" && <Icon name="travel_explore" size={16} />}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- markdown renderer with technique chips + quiz cards ----------

function childText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(childText).join("");
  if (isValidElement(node)) return childText((node.props as { children?: ReactNode }).children);
  return "";
}

const COACH_MD_COMPONENTS: Components = {
  a({ href, children }) {
    if (href?.startsWith("#tech-")) {
      return <TechTerm slug={href.slice("#tech-".length)}>{children}</TechTerm>;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: ReactNode };
      const cls = props.className ?? "";
      if (cls.includes("language-quiz")) {
        const quiz = parseQuiz(childText(props.children).trim());
        if (quiz) return <QuizCard quiz={quiz} />;
      }
      if (cls.includes("language-choices")) {
        const choices = parseChoices(childText(props.children).trim());
        if (choices) return <ChoicesCard choices={choices} />;
      }
      if (cls.includes("language-log")) {
        const log = parseLog(childText(props.children).trim());
        if (log) return <LogEntryCard spec={log} />;
      }
      if (cls.includes("language-plan")) {
        const plan = parsePlan(childText(props.children).trim());
        if (plan) return <PlanCard spec={plan} />;
      }
    }
    return <pre>{children}</pre>;
  },
};

/** Coach markdown with technique-name chips (hover for the tip) and quiz cards. */
function CoachMarkdown({ text }: { text: string }) {
  const annotated = useMemo(() => annotateTechniques(text), [text]);
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={COACH_MD_COMPONENTS}>
      {annotated}
    </Markdown>
  );
}

// ---------- session bar (goal pill + wrap-up / welcome-back strip) ----------

const CLIENT_SESSION_GAP_MS = 4 * 60 * 60 * 1000; // mirrors journey.ts SESSION_GAP_MS

/**
 * A quiet strip above the composer, derived entirely from message timestamps
 * and the learning log (model-free). Mid-session it pins the one-line session
 * goal (the latest "Today's target: …" user message) in the corner and offers
 * "Wrap up & log" once there's something to log; after a >4h silence it turns
 * into a welcome-back strip with due-topic returns and a continue button.
 */
function SessionBar({ messages, status, send }: { messages: CoachChatMessage[]; status: CoachStatus; send: (text: string) => void }) {
  const { entries, due, plan } = useJourney();
  const [now, setNow] = useState(() => Date.now());
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  useEffect(() => {
    // The 4h boundary can pass while the tab sits open — re-derive each minute.
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const persisted = messages.filter((m) => m.status === "complete" && m.createdAt);
  if (persisted.length === 0) return null;
  const lastAt = new Date(persisted[persisted.length - 1]!.createdAt!).getTime();
  const gap = now - lastAt;

  if (gap > CLIENT_SESSION_GAP_MS) {
    if (status !== "idle") return null;
    const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const lastEntry = sorted[sorted.length - 1];
    const days = Math.round(gap / 86_400_000);
    const agoLabel = gap < 86_400_000 ? "earlier today" : days <= 1 ? "yesterday" : `${days} days ago`;
    const nextIdx = plan?.tasks.findIndex((t) => t.status === "pending") ?? -1;
    const nextTask = nextIdx >= 0 ? plan!.tasks[nextIdx]! : null;
    return (
      <div className="sbar sbar--return">
        <div className="sbar__info">
          <span className="body-medium">
            <strong>Welcome back</strong> — last session {agoLabel}.
          </span>
          {lastEntry?.nextMove && <span className="sbar__next body-medium">Next move was: {lastEntry.nextMove}</span>}
        </div>
        <div className="sbar__actions">
          {nextTask && (
            <button
              type="button"
              className="sbar__chip sbar__chip--primary label-medium"
              title={nextTask.detail || nextTask.title}
              onClick={() => send(startTaskMessage(nextIdx + 1, nextTask.title))}
            >
              <Icon name="checklist" size={16} />
              Next up: {nextTask.title}
            </button>
          )}
          {due.map((d) => (
            <button
              key={d.topic}
              type="button"
              className="sbar__chip label-medium"
              onClick={() => send(quickReturnMessage(d.topic))}
            >
              <Icon name="history_edu" size={16} />
              {d.topic} · {d.daysSince}d
            </button>
          ))}
          <button
            type="button"
            className={`sbar__chip label-medium${nextTask ? "" : " sbar__chip--primary"}`}
            onClick={() => send(CONTINUE_MESSAGE)}
          >
            Pick up where you left off
          </button>
        </div>
      </div>
    );
  }

  // Active session: walk back to the session start to find the latest goal
  // message and whether anything is left to log.
  let goal: string | null = null;
  let hasUserMsg = false;
  let sessionStart = lastAt;
  let prevAt = Number.POSITIVE_INFINITY;
  for (let i = persisted.length - 1; i >= 0; i--) {
    const m = persisted[i]!;
    const at = new Date(m.createdAt!).getTime();
    if (prevAt !== Number.POSITIVE_INFINITY && prevAt - at > CLIENT_SESSION_GAP_MS) break;
    prevAt = at;
    sessionStart = at;
    if (m.role === "user") {
      hasUserMsg = true;
      if (goal === null && m.text.startsWith(GOAL_PREFIX)) goal = m.text.slice(GOAL_PREFIX.length).trim();
    }
  }
  const sessionLogged = entries.some((e) => new Date(e.createdAt).getTime() >= sessionStart);
  const showWrap = hasUserMsg && !sessionLogged && status === "idle";
  if (!goal && !showWrap) return null;

  return (
    <div className="sbar">
      {showWrap && (
        <button type="button" className="sbar__chip label-medium" onClick={() => send(WRAP_UP_MESSAGE)}>
          <Icon name="checklist" size={16} />
          Wrap up &amp; log
        </button>
      )}
      {goal !== null &&
        (goalEditing ? (
          <input
            className="sbar__goal-edit body-medium"
            autoFocus
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && goalDraft.trim()) {
                send(GOAL_PREFIX + goalDraft.trim());
                setGoalEditing(false);
              }
              if (e.key === "Escape") setGoalEditing(false);
            }}
            onBlur={() => setGoalEditing(false)}
          />
        ) : (
          <button
            type="button"
            className="sbar__goal label-medium"
            title={`Today's target: ${goal} — click to adjust`}
            onClick={() => {
              setGoalDraft(goal);
              setGoalEditing(true);
            }}
          >
            <Icon name="flag" size={14} />
            <span className="sbar__goal-text">{goal}</span>
          </button>
        ))}
    </div>
  );
}

export function CoachAvatar({ pulsing }: { pulsing?: boolean }) {
  return (
    <div className={`coach-avatar${pulsing ? " coach-avatar--pulsing" : ""}`}>
      <Icon name="psychology" size={18} />
    </div>
  );
}

interface CoachBubbleProps {
  message: CoachChatMessage;
  /** Interactive blocks (choices) are live only in the last coach message while idle. */
  interactive: boolean;
  send: (text: string) => void;
  onCopy: (m: CoachChatMessage) => void;
  /** Rewind-and-resend edit; user messages only. */
  onEdit: (m: CoachChatMessage) => void;
}

function CoachBubble({ message, interactive, send, onCopy, onEdit }: CoachBubbleProps) {
  const messageInfo = useMemo(
    () => ({ interactive, send, messageId: message.status === "complete" ? message.id : undefined }),
    [interactive, send, message.status, message.id],
  );
  if (message.role === "user") {
    return (
      <div className="msg msg--teacher">
        <div className="msg__col msg__col--teacher">
          <div className="msg__bubble msg__bubble--coach-user body-large"><TechText text={message.text} /></div>
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
            <MessageContext.Provider value={messageInfo}>
              <CoachMarkdown text={message.text} />
            </MessageContext.Provider>
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
              {messages.map((m, i) => (
                <CoachBubble
                  key={m.id}
                  message={m}
                  interactive={i === messages.length - 1 && m.role === "coach" && status === "idle"}
                  send={send}
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

      <SessionBar messages={messages} status={status} send={send} />

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
