// Account security (R24): password change, admin reset links, sign out everywhere.
// JSON shapes shared by the Worker (routes/auth.ts) and the web client.

/** POST /api/auth/password: the signed-in user's password (≥ MIN_PASSWORD_LENGTH). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/**
 * POST /api/admin/password-resets {email} (admins): a one-time link that lets that
 * account set a new password (24 h). Shaped like an invite.
 */
export interface CreateResetLinkRequest {
  email: string;
}

export interface CreateResetLinkResponse {
  email: string;
  /** `/reset/<token>` (a path; prefix the origin). */
  path: string;
  expiresAt: number;
}

/** GET /api/password-resets/:token */
export interface ResetLinkInfoResponse {
  email: string;
}

/** POST /api/password-resets/:token: sets the password, signs out everywhere, signs in. */
export interface CompleteResetRequest {
  password: string;
}

/** Reset links last a day (invites: 7 days). */
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
