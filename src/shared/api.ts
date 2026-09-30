// JSON shapes exchanged between the Worker API and the web client.
// Both sides import from here; keep it free of runtime dependencies.

/**
 * Per-show role. owner = the creator (manages members); editor = everything else;
 * commenter = read all, create/edit/delete own notes; viewer = read only.
 */
export type Role = "owner" | "editor" | "commenter" | "viewer";

export const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];
/** Roles that can be granted through the members API (there is one owner per show). */
export const GRANTABLE_ROLES: readonly Role[] = ["editor", "commenter", "viewer"];

export interface MemberDTO {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

export interface MembersResponse {
  members: MemberDTO[];
}

export interface AddMemberRequest {
  email: string;
  role: Role;
}

export interface UpdateMemberRequest {
  role: Role;
}

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

/** Returned by login and invite accept. */
export interface MeResponse {
  user: UserDTO;
}

/** GET /api/me: always 200; `user` is null when signed out. */
export interface SessionResponse {
  user: UserDTO | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ShowSummaryDTO {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
  /** A show template (R27): listed separately; "New from template" copies it. */
  isTemplate?: boolean;
}

/**
 * POST /api/shows/:id/clone (owner/editor of the source): a new show with the source's
 * surfaces, scenes (unless `includeScenes` is false), custom tables (definitions only),
 * custom fields, shared views and default unit; never cues, notes, content, shots,
 * attachments or the script. `asTemplate`: the copy is a template ("Save as template").
 */
export interface CloneShowRequest {
  name: string;
  includeScenes?: boolean;
  asTemplate?: boolean;
}

export interface CloneShowResponse {
  show: ShowSummaryDTO;
}

export interface ShowsResponse {
  shows: ShowSummaryDTO[];
}

export interface CreateShowRequest {
  name: string;
}

/** What the show's Durable Object knows about itself. */
export interface ShowMetaDTO {
  showId: string;
  name: string;
  createdAt: number;
}

/** GET /api/shows/:id: the DO's meta plus show-level fields kept in D1. */
export interface ShowInfoDTO extends ShowMetaDTO {
  /** The session new notes are stamped with ("Tech 2"); null when unset. */
  currentSession: string | null;
}

export interface ShowResponse {
  show: ShowInfoDTO;
  role: Role;
}

/**
 * PATCH /api/shows/:id. `name`: owner only. `current_session`: editors and the owner; ""
 * or null clears it. The change is broadcast to the show's sockets (`{type:"show"}`).
 */
export interface UpdateShowRequest {
  name?: string;
  current_session?: string | null;
}

export interface UpdateShowResponse {
  show: { id: string; name: string; currentSession: string | null };
}

export const MAX_SESSION_LENGTH = 100;

/**
 * POST /api/invites. Admins invite anyone; a show's owner may invite to that show
 * (`showId` required then). On accept the new account joins `showId` with `role`
 * (default editor).
 */
export interface CreateInviteRequest {
  email: string;
  showId?: string;
  role?: Role;
}

export interface CreateInviteResponse {
  email: string;
  /** Path (not absolute URL) of the one-time accept page, e.g. /invite/abc... */
  path: string;
  expiresAt: number;
}

export interface InviteInfoResponse {
  email: string;
  /** The show the account joins on accept, if any. */
  showName?: string | null;
  role?: Role | null;
}

export interface AcceptInviteRequest {
  name: string;
  password: string;
}

export interface ErrorResponse {
  error: string;
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_NAME_LENGTH = 200;

// ---- Attachments (src/shared/attachments.ts; CLAUDE.md "Attachments") ----

/** POST /api/shows/:id/attachments/upload-url: reserve an attachment for a record's field. */
export interface UploadUrlRequest {
  table: string;
  recordId: string;
  /** Default "attachments". */
  field?: string;
  filename: string;
  contentType: string;
  size: number;
  /**
   * The picture's size before the client scaled it down (images over 16 MP are resized to
   * ≤ 4096 px before upload); kept in the attachment's `custom.original_size`.
   */
  originalSize?: { width: number; height: number };
}

export interface UploadUrlResponse {
  attachmentId: string;
  /** PUT the file's bytes here (same origin; streamed into R2 by the Worker). */
  uploadUrl: string;
  /** The content type to send (the declared one, or the one inferred from the name). */
  contentType: string;
}

/** GET /api/shows/:id/storage */
export interface StorageResponse {
  usedBytes: number;
  limitBytes: number;
}
