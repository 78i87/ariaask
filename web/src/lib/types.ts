export interface SourceFile {
  originalName: string;
  storedName: string;
  extractedName: string | null;
  mimeType: string;
  size: number;
  approxWords: number | null;
}

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

export interface AppSettings {
  model: string | null;
  effort: string | null;
  replyLength: ReplyLength;
  probing: Probing;
}

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

export interface SessionStateEvent {
  turnActive: boolean;
  turnId: string | null;
  kickoffRunning: boolean;
  /** In-flight streamed text keyed by agentMessage itemId. */
  partials: Record<string, string>;
  messageCount: number;
}
