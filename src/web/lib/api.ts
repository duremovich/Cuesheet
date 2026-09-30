// Thin fetch wrapper for /api. Every call is same-origin and sends the session cookie.
import type {
  AcceptInviteRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateShowRequest,
  InviteInfoResponse,
  LoginRequest,
  MeResponse,
  SessionResponse,
  ShowResponse,
  ShowSummaryDTO,
  ShowsResponse,
} from "../../shared/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The session is missing or expired (HTTP 401). Pages pass caught errors to
 * `useApiErrorHandler()` (lib/auth.tsx), which signs the client out so `RequireAuth`
 * redirects to /login?next=<current path>.
 */
export class UnauthorizedError extends ApiError {
  constructor(message = "Not signed in") {
    super(401, message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  const message = data?.error ?? `Request failed (${res.status})`;
  if (res.status === 401) throw new UnauthorizedError(message);
  if (!res.ok) throw new ApiError(res.status, message);
  return data as T;
}

export const api = {
  me: () => request<SessionResponse>("GET", "/me"),
  login: (body: LoginRequest) => request<MeResponse>("POST", "/auth/login", body),
  logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  listShows: () => request<ShowsResponse>("GET", "/shows"),
  createShow: (body: CreateShowRequest) =>
    request<{ show: ShowSummaryDTO }>("POST", "/shows", body),
  getShow: (id: string) => request<ShowResponse>("GET", `/shows/${encodeURIComponent(id)}`),
  createInvite: (body: CreateInviteRequest) =>
    request<CreateInviteResponse>("POST", "/invites", body),
  getInvite: (token: string) =>
    request<InviteInfoResponse>("GET", `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: AcceptInviteRequest) =>
    request<MeResponse>("POST", `/invites/${encodeURIComponent(token)}/accept`, body),
};

export function showSocketUrl(showId: string, loc: Location = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/api/shows/${encodeURIComponent(showId)}/ws`;
}
