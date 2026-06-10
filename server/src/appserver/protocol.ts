/**
 * Hand-transcribed subset of the Codex app-server JSON-RPC protocol.
 * Source of truth: `codex app-server generate-ts` output @ codex-cli 0.138.0.
 * Each type notes its generated source file.
 */

// ---------- initialize ----------

// source: ClientInfo.ts
export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

// source: InitializeCapabilities.ts
export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  optOutNotificationMethods?: string[] | null;
}

// source: InitializeParams.ts
export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

// ---------- account / auth ----------

// source: AuthMode.ts
export type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken";

// source: PlanType.ts (full union elided — treat as opaque)
export type PlanType = string;

// source: v2/Account.ts
export type Account =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string; planType: PlanType }
  | { type: "amazonBedrock" };

// source: v2/GetAccountResponse.ts — method "account/read", params {refreshToken?: boolean}
export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

// source: v2/LoginAccountResponse.ts (chatgpt variant) — method "account/login/start", params {type:"chatgpt"}
export interface LoginChatGptResponse {
  type: "chatgpt";
  loginId: string;
  /** URL the client should open in a browser to initiate the OAuth flow. */
  authUrl: string;
}

// source: v2/AccountLoginCompletedNotification.ts — notification "account/login/completed"
export interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

// ---------- threads ----------

// source: v2/SandboxMode.ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// source: v2/AskForApproval.ts (granular variant elided)
export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

// source: Personality.ts equivalent — thread/start accepts these
export type Personality = string;

// source: v2/ThreadStartParams.ts (subset)
export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null;
  ephemeral?: boolean | null;
}

// source: v2/Thread.ts (subset)
export interface Thread {
  id: string;
  sessionId: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
}

// source: v2/ThreadStartResponse.ts (subset)
export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  [key: string]: unknown;
}

// source: v2/ThreadResumeParams.ts (subset; resume by threadId, re-pinning config)
export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null;
}

export interface ThreadResumeResponse {
  thread: Thread;
  [key: string]: unknown;
}

// ---------- turns ----------

// source: v2/UserInput.ts (text variant; other variants unused by Aria)
export interface TextUserInput {
  type: "text";
  text: string;
  /** UI-defined spans within `text`; always [] for Aria. */
  text_elements: unknown[];
}
export type UserInput = TextUserInput;

// source: ReasoningEffort.ts
export type ReasoningEffort = string;

// source: v2/TurnStartParams.ts (subset)
export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  effort?: ReasoningEffort | null;
}

// source: v2/TurnStatus.ts
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

// source: v2/CodexErrorInfo.ts (object variants loosened)
export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "cyberPolicy"
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "threadRollbackFailed"
  | "sandboxError"
  | "other"
  | Record<string, unknown>;

// source: v2/TurnError.ts
export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

// source: v2/Turn.ts (subset)
export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
}

// source: v2/TurnStartResponse.ts
export interface TurnStartResponse {
  turn: Turn;
}

// source: v2/TurnInterruptParams.ts
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ---------- thread items ----------

// source: v2/ThreadItem.ts — only the variants Aria inspects are narrowed
export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string; [key: string]: unknown }
  | { type: "commandExecution"; id: string; command: string; [key: string]: unknown }
  | { type: "reasoning"; id: string; [key: string]: unknown }
  | { type: "userMessage"; id: string; [key: string]: unknown }
  | ({ type: string; id: string } & Record<string, unknown>);

// ---------- notifications (server -> client) ----------

// source: v2/TurnStartedNotification.ts
export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

// source: v2/AgentMessageDeltaNotification.ts — "item/agentMessage/delta"
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// source: v2/ItemStartedNotification.ts / v2/ItemCompletedNotification.ts
export interface ItemNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

// source: v2/TurnCompletedNotification.ts
export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

// source: v2/ErrorNotification.ts — notification "error"
export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

// ---------- models ----------

// source: v2/ReasoningEffortOption.ts — live-verified on codex 0.138.0:
// elements are objects {reasoningEffort, description}.
export interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description?: string | null;
  [key: string]: unknown;
}

// source: v2/Model.ts (subset)
export interface Model {
  id: string;
  model: string;
  displayName: string;
  description?: string | null;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts?: (ReasoningEffortOption | ReasoningEffort)[];
  isDefault: boolean;
  [key: string]: unknown;
}

// source: v2/ModelListResponse.ts
export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}
