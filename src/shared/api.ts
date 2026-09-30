// JSON shapes exchanged between the Worker API and the web client.
// Both sides import from here; keep it free of runtime dependencies.

export type Role = "editor" | "commenter" | "viewer";

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export interface MeResponse {
  user: UserDTO;
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

export interface ShowResponse {
  show: ShowMetaDTO;
  role: Role;
}

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
