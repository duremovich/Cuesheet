// Thin fetch wrapper for /api. Every call is same-origin and sends the session cookie.

import type {
  ChangePasswordRequest,
  CreateResetLinkResponse,
  ResetLinkInfoResponse,
} from "../../shared/account";
import type { ImportMapping } from "../../shared/airtable-columns";
import type {
  AcceptInviteRequest,
  AddMemberRequest,
  AddPeopleRequest,
  AddShowPeopleResponse,
  AddTeamPeopleResponse,
  CloneShowRequest,
  CloneShowResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateShowRequest,
  InviteInfoResponse,
  LoginRequest,
  MemberDTO,
  MembersResponse,
  MeResponse,
  MyAccessResponse,
  PendingInvitesResponse,
  PeopleResponse,
  ReissueInviteResponse,
  SessionResponse,
  ShowResponse,
  ShowSummaryDTO,
  ShowsResponse,
  StorageResponse,
  TeamMembersResponse,
  TeamResponse,
  TeamRole,
  TeamShowsResponse,
  TeamsResponse,
  UpdateMemberRequest,
  UpdateShowRequest,
  UpdateShowResponse,
  UpdateTeamRequest,
  UploadUrlRequest,
  UploadUrlResponse,
} from "../../shared/api";
import type {
  HistoryResponse,
  ImportResponse,
  MutateRequest,
  MutateResponse,
  SnapshotResponse,
} from "../../shared/ops";
import type {
  CreateScriptVersionRequest,
  CreateScriptVersionResponse,
  ReanchorRequest,
  ReanchorResponse,
  ScriptText,
} from "../../shared/script";
import type {
  CreateShareLinkRequest,
  CreateShareLinkResponse,
  ShareInfoResponse,
  ShareLinksResponse,
} from "../../shared/share";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** For a rejected mutate batch: which op failed. */
    readonly opIndex?: number,
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init: { keepalive?: boolean } = {},
): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    ...(init.keepalive ? { keepalive: true } : {}),
    // FormData sets its own multipart Content-Type (with boundary).
    headers: body === undefined || isForm ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    opIndex?: number;
  } | null;
  const message = data?.error ?? `Request failed (${res.status})`;
  if (res.status === 401) throw new UnauthorizedError(message);
  if (!res.ok) throw new ApiError(res.status, message, data?.opIndex);
  return data as T;
}

const showPath = (id: string, rest = "") => `/shows/${encodeURIComponent(id)}${rest}`;
const teamPath = (id: string, rest = "") => `/teams/${encodeURIComponent(id)}${rest}`;

export const api = {
  me: () => request<SessionResponse>("GET", "/me"),
  login: (body: LoginRequest) => request<MeResponse>("POST", "/auth/login", body),
  logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  listShows: () => request<ShowsResponse>("GET", "/shows"),
  createShow: (body: CreateShowRequest) =>
    request<{ show: ShowSummaryDTO }>("POST", "/shows", body),
  getShow: (id: string) => request<ShowResponse>("GET", `/shows/${encodeURIComponent(id)}`),
  /** Rename (owner) / set the current session (editors). Broadcast as `{type:"show"}`. */
  updateShow: (id: string, body: UpdateShowRequest) =>
    request<UpdateShowResponse>("PATCH", showPath(id), body),
  createInvite: (body: CreateInviteRequest) =>
    request<CreateInviteResponse>("POST", "/invites", body),
  getInvite: (token: string) =>
    request<InviteInfoResponse>("GET", `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: AcceptInviteRequest) =>
    request<MeResponse>("POST", `/invites/${encodeURIComponent(token)}/accept`, body),

  // Show data (M1). Most callers go through the show store (lib/show-store.ts).
  snapshot: (id: string) => request<SnapshotResponse>("GET", showPath(id, "/snapshot")),
  /** `keepalive`: the request outlives the page (a save sent from pagehide). */
  mutate: (id: string, body: MutateRequest, opts: { keepalive?: boolean } = {}) =>
    request<MutateResponse>("POST", showPath(id, "/mutate"), body, opts),
  history: (id: string, q: { table?: string; id?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return request<HistoryResponse>("GET", showPath(id, `/history?${params}`));
  },
  /**
   * Copy a show's structure into a new show (R27): surfaces, scenes (unless
   * `includeScenes: false`), custom tables and fields, shared views; `asTemplate` makes the
   * copy a template.
   */
  cloneShow: (id: string, body: CloneShowRequest) =>
    request<CloneShowResponse>("POST", showPath(id, "/clone"), body),
  /**
   * `append`: import into a show that already has data (else the server answers 409).
   * `mapping`: the preview's choices (custom fields for unmapped columns, custom tables).
   */
  importAirtable: (
    id: string,
    files: File[],
    opts: { clientId?: string; append?: boolean; mapping?: ImportMapping } = {},
  ) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (opts.clientId) form.append("clientId", opts.clientId);
    if (opts.mapping) form.append("mapping", JSON.stringify(opts.mapping));
    const q = opts.append ? "?append=1" : "";
    return request<ImportResponse>("POST", showPath(id, `/import/airtable${q}`), form);
  },
  /** Reserve an attachment upload (then PUT the bytes with `putFile`). */
  uploadUrl: (id: string, body: UploadUrlRequest) =>
    request<UploadUrlResponse>("POST", showPath(id, "/attachments/upload-url"), body),
  storage: (id: string) => request<StorageResponse>("GET", showPath(id, "/storage")),
  /**
   * Import a script version (text extracted in the browser: `extractScript`); re-anchors
   * every cue from the current version. Then upload the original file to
   * `{table: "script_versions", recordId: versionId, field: SCRIPT_SOURCE_FIELD}` and set
   * the version's `attachment_id` with an update op.
   */
  createScriptVersion: (id: string, body: CreateScriptVersionRequest) =>
    request<CreateScriptVersionResponse>("POST", showPath(id, "/script/versions"), body),
  reanchorScriptVersion: (id: string, versionId: string, body: ReanchorRequest) =>
    request<ReanchorResponse>(
      "POST",
      showPath(id, `/script/versions/${encodeURIComponent(versionId)}/reanchor`),
      body,
    ),
  /** A version's extracted text (immutable; the browser caches it). */
  scriptText: (id: string, versionId: string) =>
    request<ScriptText>(
      "GET",
      showPath(id, `/script/versions/${encodeURIComponent(versionId)}/text`),
    ),
  members: (id: string) => request<MembersResponse>("GET", showPath(id, "/members")),
  addMember: (id: string, body: AddMemberRequest) =>
    request<{ member: MemberDTO }>("POST", showPath(id, "/members"), body),
  updateMember: (id: string, userId: string, body: UpdateMemberRequest) =>
    request<{ ok: true }>("PATCH", showPath(id, `/members/${encodeURIComponent(userId)}`), body),
  removeMember: (id: string, userId: string) =>
    request<{ ok: true }>("DELETE", showPath(id, `/members/${encodeURIComponent(userId)}`)),
  /** Owner: make another member the owner (you become an editor). */
  transferOwnership: (id: string, userId: string) =>
    request<{ ok: true }>("POST", showPath(id, "/transfer"), { userId }),
  /** Leave a show (not the owner). */
  leaveShow: (id: string) => request<{ ok: true }>("POST", showPath(id, "/leave"), {}),
  /** One step: an account is added now, an unknown email gets an invite (emailed if set up). */
  addShowPeople: (id: string, body: AddPeopleRequest) =>
    request<AddShowPeopleResponse>("POST", showPath(id, "/people"), body),
  /** Pending invites into the show (the owner sees all, others their own). */
  showInvites: (id: string) => request<PendingInvitesResponse>("GET", showPath(id, "/invites")),

  // ---- teams ----
  listTeams: () => request<TeamsResponse>("GET", "/teams"),
  createTeam: (name: string) => request<TeamResponse>("POST", "/teams", { name }),
  getTeam: (id: string) => request<TeamResponse>("GET", teamPath(id)),
  /** Rename / invite policy (owner and admins). */
  updateTeam: (id: string, body: UpdateTeamRequest) =>
    request<TeamResponse>("PATCH", teamPath(id), body),
  /** Owner; refused (409) while the team has shows. */
  deleteTeam: (id: string) => request<{ ok: true }>("DELETE", teamPath(id)),
  teamMembers: (id: string) => request<TeamMembersResponse>("GET", teamPath(id, "/members")),
  updateTeamMember: (id: string, userId: string, role: TeamRole) =>
    request<{ ok: true }>("PATCH", teamPath(id, `/members/${encodeURIComponent(userId)}`), {
      role,
    }),
  removeTeamMember: (id: string, userId: string) =>
    request<{ ok: true }>("DELETE", teamPath(id, `/members/${encodeURIComponent(userId)}`)),
  leaveTeam: (id: string) => request<{ ok: true }>("POST", teamPath(id, "/leave"), {}),
  /** Owner: make another member the owner (you become an admin). */
  transferTeam: (id: string, userId: string) =>
    request<{ ok: true }>("POST", teamPath(id, "/transfer"), { userId }),
  teamShows: (id: string) => request<TeamShowsResponse>("GET", teamPath(id, "/shows")),
  addTeamPeople: (id: string, body: AddPeopleRequest) =>
    request<AddTeamPeopleResponse>("POST", teamPath(id, "/people"), body),
  teamInvites: (id: string) => request<PendingInvitesResponse>("GET", teamPath(id, "/invites")),

  // ---- invites, people, my access ----
  /** Revoke a pending invite: its link stops working. */
  revokeInvite: (inviteId: string) =>
    request<{ ok: true }>("DELETE", `/invites/${encodeURIComponent(inviteId)}`),
  /** A new link (and 7 days) for a pending invite; the old link stops working. */
  reissueInvite: (inviteId: string) =>
    request<ReissueInviteResponse>("POST", `/invites/${encodeURIComponent(inviteId)}/reissue`, {}),
  /** Everyone you share a show or a team with (for the add-people autocomplete). */
  people: () => request<PeopleResponse>("GET", "/people"),
  myAccess: () => request<MyAccessResponse>("GET", "/me/access"),

  // ---- account security (R24) ----
  /** Ends every session of this account and closes its show sockets. */
  logoutAll: () => request<{ ok: true }>("POST", "/auth/logout-all", {}),
  changePassword: (body: ChangePasswordRequest) =>
    request<{ ok: true; sessionsEnded: number }>("POST", "/auth/password", body),
  createResetLink: (email: string) =>
    request<CreateResetLinkResponse>("POST", "/admin/password-resets", { email }),
  getResetLink: (token: string) =>
    request<ResetLinkInfoResponse>("GET", `/password-resets/${encodeURIComponent(token)}`),
  completeReset: (token: string, password: string) =>
    request<MeResponse>("POST", `/password-resets/${encodeURIComponent(token)}`, { password }),

  // ---- share links (R23) ----
  shareLinks: (id: string) => request<ShareLinksResponse>("GET", showPath(id, "/share-links")),
  createShareLink: (id: string, body: CreateShareLinkRequest) =>
    request<CreateShareLinkResponse>("POST", showPath(id, "/share-links"), body),
  /** Revoke a live link and make a new one with the same settings (tokens show once). */
  regenerateShareLink: (id: string, linkId: string) =>
    request<CreateShareLinkResponse>(
      "POST",
      showPath(id, `/share-links/${encodeURIComponent(linkId)}/regenerate`),
      {},
    ),
  revokeShareLink: (id: string, linkId: string) =>
    request<{ ok: true }>("DELETE", showPath(id, `/share-links/${encodeURIComponent(linkId)}`)),
  /** Resolve `/s/<token>` (no sign-in; sets the show's share cookie). */
  openShare: (token: string) =>
    request<ShareInfoResponse>("GET", `/share/${encodeURIComponent(token)}`),
};

/** The owner's JSON export of a show (a download link). */
export function exportUrl(showId: string): string {
  return `/api${showPath(showId, "/export.json")}`;
}

export function showSocketUrl(showId: string, loc: Location = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/api/shows/${encodeURIComponent(showId)}/ws`;
}

/**
 * PUT a file to an upload URL (from `api.uploadUrl`), reporting progress. XMLHttpRequest,
 * because fetch can't report upload progress.
 */
export function putFile(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (loaded: number) => void = () => undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size);
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
      } catch {
        // not JSON
      }
      reject(
        xhr.status === 401 ? new UnauthorizedError(message) : new ApiError(xhr.status, message),
      );
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted (network)"));
    xhr.send(file);
  });
}
