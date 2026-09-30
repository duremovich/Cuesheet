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

export interface CreateInviteRequest {
  email: string;
}

export interface CreateInviteResponse {
  email: string;
  /** Path (not absolute URL) of the one-time accept page, e.g. /invite/abc... */
  path: string;
  expiresAt: number;
}

export interface InviteInfoResponse {
  email: string;
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
