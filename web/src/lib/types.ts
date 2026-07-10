export interface SourceFile {
  originalName: string;
  storedName: string;
  extractedName: string | null;
  mimeType: string;
  size: number;
  approxWords: number | null;
  /** "research" = server-discovered online source; absent = user upload. */
  origin?: "research";
  /** Original public URL for server-discovered online sources. */
  originUrl?: string;
}

export interface DiscoverFailure {
  url: string;
  reason: string;
}

export interface IntakeOption {
  value: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  options: IntakeOption[];
  allowsCustom: boolean;
}

export type ResearchStatus = "none" | "running" | "done" | "failed";

export interface Intake {
  status: "pending" | "done";
  questions: IntakeQuestion[];
  research: ResearchStatus;
}

export type IntakeAnswerPayload = Record<string, { value?: string; custom?: string }>;

export interface Notebook {
  id: string;
  title: string;
  type: "topic" | "files";
  topic: string | null;
  sourceFiles: SourceFile[];
  createdAt: string;
  lastTaughtAt: string | null;
  messageCount: number;
}

export type MessageStatus = "complete" | "streaming" | "error";

export interface ChatMessage {
  id: string;
  role: "teacher" | "student";
  text: string;
  status: MessageStatus;
  interrupted?: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  email?: string;
  planType?: string;
}

export type ReplyLength = "concise" | "default" | "chatty";
export type Probing = "gentle" | "default" | "relentless";
export type RagMode = "off" | "auto" | "always";
export type RagRecall = "light" | "default" | "generous";

export interface AppSettings {
  model: string | null;
  effort: string | null;
  replyLength: ReplyLength;
  probing: Probing;
  ragMode: RagMode;
  ragRecall: RagRecall;
}

export interface CyraThreadSummary {
  id: string;
  title: string;
  sourceMessageId: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CyraChatMessage {
  id: string;
  /** "user" = you asking; "cyra" = the expert teacher. */
  role: "user" | "cyra";
  text: string;
  status: "complete" | "streaming";
  interrupted?: boolean;
}

export interface CoachChatMessage {
  id: string;
  /** "user" = the learner; "coach" = the AI learning coach. */
  role: "user" | "coach";
  text: string;
  status: "complete" | "streaming";
  interrupted?: boolean;
  /** Absent only on messages that streamed in before the page knew better. */
  createdAt?: string;
}

// Mirrors server/src/domain/usage.ts.
export type CoachMode = "guided" | "intermediate" | "experienced";

export interface Usage {
  coachMode: CoachMode;
  techniques: Record<string, { uses: number; lastUsedAt: string }>;
}

// Mirrors server/src/domain/store.ts reading types.
export type ReadingLevel = "beginner" | "intermediate" | "experienced";

export type ReadingAnnotationKind = "pause" | "simplify" | "compare" | "connect" | "judge" | "apply" | "technique";

export interface ReadingAnnotation {
  id: string;
  /** 1-based page number. */
  page: number;
  /** Exact quote from the page; matched against the PDF.js text layer. */
  anchor: string;
  kind: ReadingAnnotationKind;
  prompt: string;
  userResponse?: string;
  resolved?: boolean;
}

export interface ReadingSession {
  id: string;
  source: string;
  level: ReadingLevel;
  status: "generating" | "ready" | "failed";
  error?: string;
  annotations: ReadingAnnotation[];
  afterReading: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReadingSessionSummary {
  id: string;
  source: string;
  level: ReadingLevel;
  status: "generating" | "ready" | "failed";
  annotationCount: number;
  createdAt: string;
}

/** One learning-log entry — the durable record of one study block. */
export interface LearningLogEntry {
  id: string;
  topic: string;
  goal: string;
  strategy: string;
  resultGap: string;
  nextMove: string;
  source: "coach" | "user";
  createdAt: string;
  updatedAt?: string;
}

/** A topic loosely due for a spaced return (computed server-side). */
export interface DueTopic {
  topic: string;
  daysSince: number;
  intervalDays: number;
  entryCount: number;
}

/** A due topic with its project, for the cross-project sidebar strip. */
export interface GlobalDueTopic {
  notebookId: string;
  notebookTitle: string;
  topic: string;
  daysSince: number;
  intervalDays: number;
}

/** Which pane the session view is showing. */
export type ThreadSelection = { kind: "aria" } | { kind: "map" } | { kind: "cyra"; threadId: string | null };

export interface EffortInfo {
  effort: string;
  description: string | null;
}

export interface ModelInfo {
  model: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: EffortInfo[];
}

export interface SettingsResponse {
  settings: AppSettings;
  models: ModelInfo[];
}

// Mirrors server/src/domain/knowledge.ts. Server-driven: arrives on
// GET /api/notebooks/:id (`knowledgeState`) and via the "knowledge-state" SSE
// event; rendered by the knowledge map pane (KnowledgeMapView).
export type KnowledgeStatus = "unknown" | "misconception" | "partial" | "understood";

export interface KnowledgeBelief {
  id: string;
  concept: string;
  status: KnowledgeStatus;
  belief: string;
  note?: string;
  /** Cluster label for the knowledge map; absent on pre-feature beliefs ("General"). */
  area?: string;
  /** Ids of prerequisite beliefs — the map's edges. */
  deps?: string[];
  /** When the evaluator last touched this concept. */
  touchedAt?: string;
}

export interface KnowledgeChange {
  beliefId: string;
  concept: string;
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  belief?: string;
  justification: string;
}

export interface KnowledgeState {
  version: 1;
  beliefs: KnowledgeBelief[];
  lastChanges: KnowledgeChange[];
  lastEvaluatedMessageId: string | null;
  updatedAt: string;
}

export interface SessionStateEvent {
  turnActive: boolean;
  turnId: string | null;
  kickoffRunning: boolean;
  /** True while the pre-kickoff online source discovery is running. */
  intakeRunning: boolean;
  /** True while mid-session online source discovery is running. */
  discoveryRunning?: boolean;
  /** True while the reading-recall index is being (re)built. */
  ragBuilding?: boolean;
  /** True when the most recent index build failed (recall not actually ready). */
  ragBuildFailed?: boolean;
  /** In-flight streamed text keyed by agentMessage itemId. */
  partials: Record<string, string>;
  messageCount: number;
}
