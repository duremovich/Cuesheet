// Thin fetch wrapper for /api. Every call is same-origin and sends the session cookie.

import type { ImportMapping } from "../../shared/airtable-columns";
import type {
  AcceptInviteRequest,
  AddMemberRequest,
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
  SessionResponse,
  ShowResponse,
  ShowSummaryDTO,
  ShowsResponse,
  StorageResponse,
  UpdateMemberRequest,
  UpdateShowRequest,
  UpdateShowResponse,
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
};

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
