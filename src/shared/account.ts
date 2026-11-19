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

// ---- Profile: display name and login email ----

/** PATCH /api/me: rename yourself (trimmed, 1–MAX_NAME_LENGTH characters) → MeResponse. */
export interface UpdateProfileRequest {
  name: string;
}

/**
 * POST /api/me/email: ask to change your login email. A one-time link goes to the new
 * address; nothing changes until it's opened (POST /api/email-changes/:token).
 */
export interface ChangeEmailRequest {
  newEmail: string;
  currentPassword: string;
}

/** A requested login-email change waiting for its link (GET /api/me/access `pendingEmail`). */
export interface PendingEmailChange {
  email: string;
  expiresAt: number;
}

/**
 * POST /api/me/email and POST /api/me/email/resend. `emailed: false` with `message` when
 * email isn't set up or the send failed: the change stays pending (resend or cancel), and
 * the link is never returned (only the new address may confirm it).
 */
export interface ChangeEmailResponse {
  pending: PendingEmailChange;
  emailed: boolean;
  message?: string;
}

/** GET /api/email-changes/:token: the address the link would switch the login to. */
export interface EmailChangeInfoResponse {
  email: string;
}

/** POST /api/email-changes/:token: the login email is now `email`. */
export interface ConfirmEmailChangeResponse {
  email: string;
}

/** Email-change links last a day. */
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
