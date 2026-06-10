import type {
  AppSettings,
  AuthStatus,
  ChatMessage,
  Intake,
  IntakeAnswerPayload,
  Notebook,
  SettingsResponse,
  SourceFile,
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
  getNotebook: (id: string) =>
    request<{
      notebook: Notebook;
      messages: { id: string; role: "teacher" | "student"; text: string; interrupted?: boolean }[];
      turnActive: boolean;
      intake: Intake | null;
    }>(`/api/notebooks/${id}`),
  submitIntake: (id: string, payload: { skip?: boolean; answers?: IntakeAnswerPayload }) =>
    request<Record<string, never>>(`/api/notebooks/${id}/intake`, json(payload)),
  deleteNotebook: (id: string) => request<void>(`/api/notebooks/${id}`, { method: "DELETE" }),

  sendMessage: (id: string, text?: string, retry?: boolean, clientMessageId?: string) =>
    request<{ turnId: string | null }>(
      `/api/notebooks/${id}/messages`,
      json(retry ? { retry: true } : text !== undefined ? { text, clientMessageId } : {}),
    ),
  interrupt: (id: string) => request<unknown>(`/api/notebooks/${id}/interrupt`, { method: "POST" }),

  /** Raw URL (not a request wrapper) — used by the previewer's iframe and text fetch. */
  sourceUrl: (id: string, storedName: string) => `/api/notebooks/${id}/sources/${encodeURIComponent(storedName)}`,
  addSources: (id: string, form: FormData) =>
    request<{ notebook: Notebook; added: SourceFile[]; warnings: string[] }>(`/api/notebooks/${id}/sources`, {
      method: "POST",
      body: form,
    }),
  deleteSource: (id: string, storedName: string) =>
    request<{ notebook: Notebook }>(`/api/notebooks/${id}/sources/${encodeURIComponent(storedName)}`, {
      method: "DELETE",
    }),

  getSettings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>("/api/settings", { ...json(patch), method: "PUT" }),
};

export type { ChatMessage };
