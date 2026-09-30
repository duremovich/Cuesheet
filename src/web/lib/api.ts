// Thin fetch wrapper for /api. Every call is same-origin and sends the session cookie.
import type {
  AcceptInviteRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateShowRequest,
  InviteInfoResponse,
  LoginRequest,
  MeResponse,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  me: () => request<MeResponse>("GET", "/me"),
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
