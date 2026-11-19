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

/**
 * Team role. owner = exactly one (the creator; transfers like a show); admin = manages
 * the team's members (but not the owner) and settings. On every show of the team a team
 * owner/admin is an editor, the others get the same-named show role.
 */
export type TeamRole = "owner" | "admin" | "editor" | "commenter" | "viewer";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "editor", "commenter", "viewer"];
/** Team roles that can be granted (one owner per team: that's a transfer). */
export const GRANTABLE_TEAM_ROLES: readonly TeamRole[] = ["admin", "editor", "commenter", "viewer"];

/** Who may invite: editors and up (`editors`), or only the owner (+ team admins: `owner`). */
export type InvitePolicy = "editors" | "owner";
export const INVITE_POLICIES: readonly InvitePolicy[] = ["editors", "owner"];

/** Someone, by id and name (who invited a member). */
export interface PersonRefDTO {
  id: string;
  name: string;
}

/**
 * GET /api/shows/:id/members: the show's direct members plus the members of its team. A
 * person with both appears once, with the effective (highest) role.
 */
export interface MemberDTO {
  userId: string;
  email: string;
  name: string;
  /** Effective role in the show. */
  role: Role;
  /**
   * `direct`: has a membership of the show (managed here); `team`: access only through
   * the show's team (managed in the team).
   */
  source: "direct" | "team";
  /** The direct membership's role (null for `team` rows). */
  directRole: Role | null;
  /** Their role in the show's team, when they're in it (also on `direct` rows). */
  teamRole: TeamRole | null;
  invitedBy: PersonRefDTO | null;
  /** When the direct membership (or, for team rows, the team membership) was made. */
  joinedAt: number;
  lastActiveAt: number | null;
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

/** POST /api/shows/:id/transfer (owner): name the member by id or by email. */
export interface TransferOwnershipRequest {
  userId?: string;
  email?: string;
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
  /** Effective role: the highest of the direct membership's and the team-derived one. */
  role: Role;
  createdAt: number;
  /** A show template (R27): listed separately; "New from template" copies it. */
  isTemplate?: boolean;
  /** The team the show belongs to (null: personal). */
  teamId: string | null;
  teamName: string | null;
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

/** POST /api/shows. With `teamId` the creator must be an editor (or up) of that team. */
export interface CreateShowRequest {
  name: string;
  teamId?: string | null;
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
  /**
   * Move the show into a team (owner, who must be a team editor or up) or back to
   * personal (`null`: the owner, or the team's owner/admins).
   */
  teamId?: string | null;
}

export interface UpdateShowResponse {
  show: { id: string; name: string; currentSession: string | null };
}

export const MAX_SESSION_LENGTH = 100;

// ---- Teams (src/worker/routes/teams.ts) ----

export interface TeamDTO {
  id: string;
  name: string;
  /** Your role in the team. */
  role: TeamRole;
  invitePolicy: InvitePolicy;
  createdAt: number;
}

export interface TeamsResponse {
  teams: TeamDTO[];
}

export interface TeamResponse {
  team: TeamDTO;
}

export interface CreateTeamRequest {
  name: string;
}

/** PATCH /api/teams/:id (owner and admins). */
export interface UpdateTeamRequest {
  name?: string;
  invitePolicy?: InvitePolicy;
}

export interface TeamMemberDTO {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
  invitedBy: PersonRefDTO | null;
  joinedAt: number;
  lastActiveAt: number | null;
}

export interface TeamMembersResponse {
  members: TeamMemberDTO[];
}

/** POST /api/teams/:id/members: an existing account joins now (no account: 404). */
export interface AddTeamMemberRequest {
  email: string;
  role: TeamRole;
}

export interface UpdateTeamMemberRequest {
  role: TeamRole;
}

/** POST /api/teams/:id/transfer (owner): name the member by id or by email. */
export interface TransferTeamRequest {
  userId?: string;
  email?: string;
}

export interface TeamShowsResponse {
  shows: ShowSummaryDTO[];
}

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
