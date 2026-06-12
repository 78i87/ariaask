export interface SourceFile {
  originalName: string;
  storedName: string;
  extractedName: string | null;
  mimeType: string;
  size: number;
  approxWords: number | null;
  /** "research" = server-generated online-research digest; absent = user upload. */
  origin?: "research";
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

// Mirrors server/src/domain/learning.ts. Server-driven: arrives on
// GET /api/notebooks/:id (`learningState`) and via the "learning-state" SSE
// event; rendered by the knowledge map pane (KnowledgeMapView).
export type BeliefStatus = "unknown" | "misconception" | "partial" | "understood";

export interface Belief {
  id: string;
  concept: string;
  status: BeliefStatus;
  belief: string;
  challenged?: true;
  note?: string;
  /** Cluster label for the knowledge map; absent on pre-feature beliefs ("General"). */
  area?: string;
  /** Ids of prerequisite beliefs — the map's edges. */
  deps?: string[];
  /** When the evaluator last touched this belief. */
  touchedAt?: string;
}

export interface BeliefChange {
  beliefId: string;
  concept: string;
  from: BeliefStatus;
  to: BeliefStatus;
  belief?: string;
  justification: string;
}

export interface LearningState {
  version: 1;
  beliefs: Belief[];
  lastChanges: BeliefChange[];
  lastEvaluatedMessageId: string | null;
  updatedAt: string;
}

export interface SessionStateEvent {
  turnActive: boolean;
  turnId: string | null;
  kickoffRunning: boolean;
  /** True while the pre-kickoff online research is running. */
  intakeRunning: boolean;
  /** In-flight streamed text keyed by agentMessage itemId. */
  partials: Record<string, string>;
  messageCount: number;
}
