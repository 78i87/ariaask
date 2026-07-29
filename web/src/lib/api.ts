import type {
  AppSettings,
  AuthStatus,
  ChatMessage,
  CyraThreadSummary,
  DueTopic,
  DiscoveryClarificationQuestion,
  DiscoveryRequest,
  GlobalDueTopic,
  Intake,
  IntakeAnswerPayload,
  KnowledgeState,
  LearningLogEntry,
  Notebook,
  ProjectActivity,
  ReadingAnnotation,
  ReadingLevel,
  ReadingSession,
  ReadingSessionSummary,
  CoachMode,
  CodexCliStatus,
  SettingsResponse,
  SourceFile,
  StudyPlan,
  Usage,
} from "./types";

export class ApiError extends Error {
  constructor(
    public kind: "network" | "http",
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("network", "Can't reach Aria's backend");
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError("http", err?.message ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  loginStart: () => request<{ loginId: string; authUrl: string }>("/api/auth/login", { method: "POST" }),
  loginPoll: (loginId: string) =>
    request<{ status: "pending" | "success" | "failed"; error?: string }>(`/api/auth/login/${loginId}`),
  loginCancel: (loginId: string) => request<void>(`/api/auth/login/${loginId}`, { method: "DELETE" }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  listNotebooks: () => request<{ notebooks: Notebook[] }>("/api/notebooks"),
  createNotebook: (form: FormData) =>
    request<{ notebook: Notebook; warnings: string[] }>("/api/notebooks", { method: "POST", body: form }),
  getNotebook: (id: string, activityId: string) =>
    request<{
      notebook: Notebook;
      activity: ProjectActivity;
      messages: { id: string; role: "teacher" | "student"; text: string; interrupted?: boolean }[];
      turnActive: boolean;
      knowledgeState: KnowledgeState | null;
      intake: Intake | null;
    }>(`/api/notebooks/${id}/activities/${activityId}/session`),
  submitIntake: (id: string, activityId: string, payload: { skip?: boolean; answers?: IntakeAnswerPayload }) =>
    request<Record<string, never>>(`/api/notebooks/${id}/activities/${activityId}/intake`, json(payload)),
  renameNotebook: (id: string, title: string) =>
    request<{ notebook: Notebook }>(`/api/notebooks/${id}`, { ...json({ title }), method: "PATCH" }),
  updateNotebook: (id: string, patch: { title?: string; archived?: boolean }) =>
    request<{ notebook: Notebook }>(`/api/notebooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteNotebook: (id: string) => request<void>(`/api/notebooks/${id}`, { method: "DELETE" }),
  createActivity: (id: string, form: FormData) =>
    request<{ activity: ProjectActivity; notebook: Notebook; warnings: string[] }>(
      `/api/notebooks/${id}/activities`,
      { method: "POST", body: form },
    ),
  renameActivity: (id: string, activityId: string, title: string) =>
    request<{ activity: ProjectActivity; notebook: Notebook }>(
      `/api/notebooks/${id}/activities/${activityId}`,
      { ...json({ title }), method: "PATCH" },
    ),
  updateActivity: (id: string, activityId: string, patch: { title?: string; cvSource?: string }) =>
    request<{ activity: ProjectActivity; notebook: Notebook }>(
      `/api/notebooks/${id}/activities/${activityId}`,
      { ...json(patch), method: "PATCH" },
    ),
  deleteActivity: (id: string, activityId: string) =>
    request<void>(`/api/notebooks/${id}/activities/${activityId}`, { method: "DELETE" }),

  sendMessage: (id: string, activityId: string, text?: string, retry?: boolean, clientMessageId?: string) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/messages`,
      json(retry ? { retry: true } : text !== undefined ? { text, clientMessageId } : {}),
    ),
  interrupt: (id: string, activityId: string) =>
    request<unknown>(`/api/notebooks/${id}/activities/${activityId}/interrupt`, { method: "POST" }),
  /** Rewind-and-resend: replaces the message and deletes everything after it. */
  editMessage: (id: string, activityId: string, messageId: string, text: string, clientMessageId?: string) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/messages/${messageId}/edit`,
      json({ text, clientMessageId }),
    ),

  listCyraThreads: (id: string, activityId: string) =>
    request<{ threads: CyraThreadSummary[] }>(`/api/notebooks/${id}/activities/${activityId}/cyra`),
  createCyraThread: (id: string, activityId: string, body: { text: string; clientMessageId?: string; sourceMessageId?: string }) =>
    request<{ thread: CyraThreadSummary; turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/cyra`,
      json(body),
    ),
  getCyraThread: (id: string, activityId: string, tid: string) =>
    request<{
      thread: CyraThreadSummary;
      messages: { id: string; role: "user" | "cyra"; text: string; interrupted?: boolean }[];
      turnActive: boolean;
    }>(`/api/notebooks/${id}/activities/${activityId}/cyra/${tid}`),
  sendCyraMessage: (id: string, activityId: string, tid: string, body: { text?: string; retry?: boolean; clientMessageId?: string }) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/cyra/${tid}/messages`,
      json(body),
    ),
  /** Rewind-and-resend within a Cyra conversation. */
  editCyraMessage: (id: string, activityId: string, tid: string, messageId: string, text: string, clientMessageId?: string) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/cyra/${tid}/messages/${messageId}/edit`,
      json({ text, clientMessageId }),
    ),
  interruptCyra: (id: string, activityId: string, tid: string) =>
    request<unknown>(`/api/notebooks/${id}/activities/${activityId}/cyra/${tid}/interrupt`, { method: "POST" }),
  /** Raw URL for the per-thread EventSource. */
  cyraEventsUrl: (id: string, activityId: string, tid: string) =>
    `/api/notebooks/${id}/activities/${activityId}/cyra/${tid}/events`,

  getCoach: (id: string, activityId: string) =>
    request<{
      coach: { kickoffDone: boolean };
      messages: { id: string; role: "user" | "coach"; text: string; interrupted?: boolean; createdAt?: string }[];
      turnActive: boolean;
    }>(`/api/notebooks/${id}/activities/${activityId}/coach`),
  coachKickoff: (id: string, activityId: string) =>
    request<{ turnId: string | null }>(`/api/notebooks/${id}/activities/${activityId}/coach/kickoff`, { method: "POST" }),
  sendCoachMessage: (id: string, activityId: string, body: { text?: string; retry?: boolean; clientMessageId?: string }) =>
    request<{ turnId: string | null }>(`/api/notebooks/${id}/activities/${activityId}/coach/messages`, json(body)),
  /** Rewind-and-resend within the coach conversation. */
  editCoachMessage: (id: string, activityId: string, messageId: string, text: string, clientMessageId?: string) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/activities/${activityId}/coach/messages/${messageId}/edit`,
      json({ text, clientMessageId }),
    ),
  interruptCoach: (id: string, activityId: string) =>
    request<unknown>(`/api/notebooks/${id}/activities/${activityId}/coach/interrupt`, { method: "POST" }),
  /** Raw URL for the coach EventSource. */
  coachEventsUrl: (id: string, activityId: string) =>
    `/api/notebooks/${id}/activities/${activityId}/coach/events`,
  activityEventsUrl: (id: string, activityId: string) =>
    `/api/notebooks/${id}/activities/${activityId}/events`,
  /** Raw URL for the notebook (teach-back) EventSource — sources/discovery updates. */
  notebookEventsUrl: (id: string) => `/api/notebooks/${id}/events`,

  listReadings: (id: string) => request<{ sessions: ReadingSessionSummary[] }>(`/api/notebooks/${id}/reading`),
  createReading: (id: string, body: { source: string; level: ReadingLevel }) =>
    request<{ session: ReadingSession }>(`/api/notebooks/${id}/reading`, json(body)),
  getReading: (id: string, rid: string) => request<{ session: ReadingSession }>(`/api/notebooks/${id}/reading/${rid}`),
  updateReadingAnnotation: (id: string, rid: string, aid: string, patch: { userResponse?: string; resolved?: boolean }) =>
    request<{ annotation: ReadingAnnotation }>(`/api/notebooks/${id}/reading/${rid}/annotations/${aid}`, {
      ...json(patch),
      method: "PATCH",
    }),
  deleteReading: (id: string, rid: string) =>
    request<void>(`/api/notebooks/${id}/reading/${rid}`, { method: "DELETE" }),

  getLog: (id: string) => request<{ entries: LearningLogEntry[]; due: DueTopic[] }>(`/api/notebooks/${id}/log`),
  addLogEntry: (id: string, body: Partial<LearningLogEntry> & { topic: string }) =>
    request<{ entry: LearningLogEntry; due: DueTopic[] }>(`/api/notebooks/${id}/log`, json(body)),
  updateLogEntry: (id: string, eid: string, patch: Partial<Omit<LearningLogEntry, "id">>) =>
    request<{ entry: LearningLogEntry; due: DueTopic[] }>(`/api/notebooks/${id}/log/${eid}`, {
      ...json(patch),
      method: "PATCH",
    }),
  deleteLogEntry: (id: string, eid: string) =>
    request<void>(`/api/notebooks/${id}/log/${eid}`, { method: "DELETE" }),
  getGlobalDue: () => request<{ due: GlobalDueTopic[] }>("/api/journey/due"),

  getPlan: (id: string) => request<{ plan: StudyPlan | null }>(`/api/notebooks/${id}/plan`),
  savePlan: (id: string, body: { id?: string; source?: "coach" | "user"; tasks: { title: string; detail?: string; topic?: string }[] }) =>
    request<{ plan: StudyPlan }>(`/api/notebooks/${id}/plan`, json(body)),
  updatePlanTask: (id: string, tid: string, status: "pending" | "done") =>
    request<{ plan: StudyPlan }>(`/api/notebooks/${id}/plan/tasks/${tid}`, { ...json({ status }), method: "PATCH" }),
  deletePlan: (id: string) => request<void>(`/api/notebooks/${id}/plan`, { method: "DELETE" }),

  /** Raw URL (not a request wrapper) — used by the previewer's iframe and text fetch. */
  sourceUrl: (id: string, storedName: string) => `/api/notebooks/${id}/sources/${encodeURIComponent(storedName)}`,
  sourcePreview: (id: string, storedName: string) =>
    request<{ kind: "markdown" | "text"; content: string; truncated: boolean }>(
      `/api/notebooks/${id}/sources/${encodeURIComponent(storedName)}/preview`,
    ),
  addSources: (id: string, form: FormData) =>
    request<{ notebook: Notebook; added: SourceFile[]; warnings: string[] }>(`/api/notebooks/${id}/sources`, {
      method: "POST",
      body: form,
    }),
  clarifyDiscovery: (id: string, body: { request: string; activityId?: string }) =>
    request<{ questions: DiscoveryClarificationQuestion[]; tailored: boolean }>(
      `/api/notebooks/${id}/discover/clarify`,
      json(body),
    ),
  discoverSources: (id: string, body: DiscoveryRequest) =>
    request<{ accepted: true }>(`/api/notebooks/${id}/discover`, json(body)),
  deleteSource: (id: string, storedName: string) =>
    request<{ notebook: Notebook }>(`/api/notebooks/${id}/sources/${encodeURIComponent(storedName)}`, {
      method: "DELETE",
    }),

  getSettings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>("/api/settings", { ...json(patch), method: "PUT" }),

  getCodexStatus: () => request<CodexCliStatus>("/api/codex/status"),
  updateCodex: () =>
    request<CodexCliStatus>("/api/codex/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aria-Local-Action": "codex-update" },
      body: "{}",
    }),

  getUsage: () => request<{ usage: Usage }>("/api/usage"),
  updateUsage: (patch: { coachMode: CoachMode }) =>
    request<{ usage: Usage }>("/api/usage", { ...json(patch), method: "PUT" }),
};

export type { ChatMessage };
