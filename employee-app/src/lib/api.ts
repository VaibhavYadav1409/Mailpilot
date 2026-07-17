// REST client for MailPilot Enterprise's actual backend (Express + Prisma).
//
// Auth model (see backend/src/routes/auth.ts + middleware/auth.ts):
//  - POST /api/auth/login returns { accessToken, employee } and sets an
//    httpOnly refresh-token cookie.
//  - Every other authenticated request sends `Authorization: Bearer <accessToken>`.
//  - The access token is short-lived; on a 401 we transparently try
//    POST /api/auth/refresh (which reads the httpOnly cookie) once, then
//    retry the original request before giving up.
//
// The access token itself is kept in memory + sessionStorage (not
// localStorage) so it doesn't silently outlive the tab in a shared machine,
// while still surviving a page refresh.

const API_URL = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "mailpilot.accessToken";

let accessToken: string | null = sessionStorage.getItem(TOKEN_KEY);

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/api/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        setAccessToken(data.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

async function request<T>(path: string, init: RequestInit = {}, _retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });

  if (res.status === 401 && !_retried) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, true);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path, { method: "GET" });
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Employee {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  companyId: string;
  departmentId: string | null;
}

export const authApi = {
  async login(email: string, password: string) {
    const data = await post<{ accessToken: string; employee: Employee }>("/api/auth/login", { email, password });
    setAccessToken(data.accessToken);
    return data.employee;
  },
  async me() {
    const data = await get<{ employee: Employee }>("/api/auth/me");
    return data.employee;
  },
  async logout() {
    try {
      await post("/api/auth/logout");
    } finally {
      setAccessToken(null);
    }
  },
};

// ---------------------------------------------------------------------------
// Gmail / mail account connection (Gmail OAuth + IMAP)
// ---------------------------------------------------------------------------

export interface GmailStatus {
  connected: boolean;
  email: string | null;
  provider: "gmail" | "imap" | "manual" | null;
  googleConfigured: boolean;
  // Conditional Sending: only a connected Gmail account can send through
  // MailPilot. IMAP/manual accounts are read-only — sendDisabledMessage is
  // set (and canSend is false) whenever Reply/Compose/Forward/Send should
  // be hidden or disabled in the UI.
  canSend: boolean;
  sendDisabledMessage: string | null;
}

export const gmailApi = {
  status: () => get<GmailStatus>("/api/gmail/status"),
  /** Fetches the Google OAuth URL, then hands off to it — GET /api/gmail/connect requires the Bearer token, so this can't be a plain <a href>. */
  async connectAndRedirect() {
    const { authUrl } = await get<{ authUrl: string }>("/api/gmail/connect");
    window.location.href = authUrl;
  },
  disconnect: () => post<{ success: boolean }>("/api/gmail/disconnect"),
};

export interface ImapConnectInput {
  email: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
}

export const imapApi = {
  connect: (input: ImapConnectInput) => post<{ success: boolean }>("/api/auth/imap", input),
};

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailRecord {
  id: string;
  threadId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string | null; // JSON-encoded string[]
  subject: string | null;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isTrashed: boolean;
  isReplied: boolean;
  // Omitted from the list endpoint (GET /api/emails) to keep the inbox
  // payload light; only present once the per-email detail fetch
  // (GET /api/emails/:id) resolves. EmailBody/selectedListItem already
  // tolerate this being absent and fall back to `snippet`.
  bodyText?: string | null;
  snippet: string | null;
  category?: { label: string; confidence: number | null } | null;
  attachments?: AttachmentRecord[];
}

export interface SentRecord {
  replyId: string;
  sentAt: string;
  wasAIDraft: boolean;
  wasAIEdited: boolean;
  replyTimeSec: number;
  email: EmailRecord;
}

export interface EmailListParams {
  filter?: "all" | "unread" | "read" | "replied" | "unreplied" | "sent" | "promotions";
  search?: string;
}

/** Translates the employee-app's filter pills into the query params emails.ts actually understands. */
function filterToParams(filter: EmailListParams["filter"]): Record<string, string> {
  switch (filter) {
    case "unread":
      return { unreadOnly: "true" };
    case "replied":
      return { }; // no direct backend filter; approximated client-side (see emailsApi.list)
    default:
      return {};
  }
}

export const emailsApi = {
  async list(params: EmailListParams): Promise<EmailRecord[]> {
    // "Sent" is backed by the Reply table (GET /api/emails/sent), not
    // Email rows — map each reply's parent email into the same EmailRecord
    // shape so the rest of the UI (list rendering, selection, detail fetch)
    // doesn't need a special case. isReplied is always true here by
    // definition; subject gets a "Re:" prefix so sent items are visually
    // distinguishable from the inbox view of the same underlying email.
    if (params.filter === "sent") {
      const sent = await emailsApi.sent();
      return sent.map((r) => ({
        ...r.email,
        id: r.email.id,
        subject: r.email.subject ? `Re: ${r.email.subject.replace(/^Re:\s*/i, "")}` : "Re:",
        isReplied: true,
        snippet: `You replied${r.wasAIDraft ? " (AI-assisted)" : ""}`,
      }));
    }

    const query = new URLSearchParams({ limit: "100", ...filterToParams(params.filter) });
    if (params.search) query.set("search", params.search);
    const data = await get<{ emails: EmailRecord[] }>(`/api/emails?${query.toString()}`);
    let emails = data.emails;
    // Filters emails.ts doesn't support server-side are applied here.
    if (params.filter === "read") emails = emails.filter((e) => e.isRead);
    if (params.filter === "replied") emails = emails.filter((e) => e.isReplied);
    if (params.filter === "unreplied") emails = emails.filter((e) => !e.isReplied);
    if (params.filter === "promotions") emails = emails.filter((e) => e.category?.label === "Spam/Promotional");
    return emails;
  },
  /** GET /api/emails/sent — real outgoing-mail history, backed by the Reply table (an Email row is never created for a sent reply). */
  sent: () => get<{ sent: SentRecord[] }>("/api/emails/sent").then((d) => d.sent),
  get: (id: string) => get<{ email: EmailRecord }>(`/api/emails/${id}`).then((d) => d.email),
  /** Full thread for an email (same threadId, same mailbox), oldest-first. */
  thread: (id: string) => get<{ thread: EmailRecord[] }>(`/api/emails/${id}/thread`).then((d) => d.thread),
  sync: () => post<{ synced: number }>("/api/emails/sync"),
  patch: (id: string, data: { isRead?: boolean; isStarred?: boolean; isTrashed?: boolean }) =>
    patch<{ email: EmailRecord }>(`/api/emails/${id}`, data),
  insights: (id: string) =>
    get<{
      summary: string | null;
      priorityScore: number | null;
      priorityRationale: string | null;
      suggestedReply: string | null;
      summaryActionId: string | null;
      priorityActionId: string | null;
      suggestedReplyActionId: string | null;
    }>(`/api/emails/${id}/insights`),
  generateSummary: (id: string, force = false) => post<{ summary: string; actionId?: string }>(`/api/emails/${id}/summary`, { force }),
  generatePriority: (id: string, force = false) =>
    post<{ priorityScore: number; priorityRationale: string; actionId?: string }>(`/api/emails/${id}/priority`, { force }),
  generateSuggestedReply: (id: string, force = false) =>
    post<{ suggestedReply: string; actionId?: string }>(`/api/emails/${id}/suggested-reply`, { force }),
  /** Tells the backend whether an AI suggestion (summary/priority/reply) was actually used — feeds DailyAnalytics.aiAcceptanceRate. */
  recordOutcome: (aiActionId: string, accepted: boolean) =>
    post<{ success: boolean }>("/api/emails/ai-actions/outcome", { aiActionId, accepted }),
  /** Direct-download URL for an inbound attachment; the browser handles auth via the existing session cookie is NOT used here — this opens in-tab so it relies on the Authorization header, hence why callers fetch+blob rather than a plain <a href>. */
  attachmentUrl: (emailId: string, attachmentId: string) => `${API_URL}/api/emails/${emailId}/attachments/${attachmentId}`,
  async downloadAttachment(emailId: string, attachment: AttachmentRecord) {
    const headers = new Headers();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    const res = await fetch(`${API_URL}/api/emails/${emailId}/attachments/${attachment.id}`, {
      headers,
      credentials: "include",
    });
    if (!res.ok) throw new ApiError(`Failed to download attachment (${res.status})`, res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = attachment.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  reply: (id: string, data: { body: string; wasAIDraft?: boolean; wasAIEdited?: boolean; attachments?: { filename: string; mimeType: string; data: string }[] }) =>
    post<{ reply: unknown }>(`/api/emails/${id}/reply`, data),
  saveManual: (data: { subject?: string; fromAddress?: string; bodyText: string }) =>
    post<{ email: EmailRecord }>("/api/emails", data).then((d) => d.email),
};
