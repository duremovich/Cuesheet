// Email through Resend (POST https://api.resend.com/emails), optional: without the
// RESEND_API_KEY secret nothing is sent and invites work by copying the link. Sending never
// fails a request: the caller reports `emailed: false` and the UI says to copy the link.
// Sender: the EMAIL_FROM var. Links point at APP_ORIGIN when set, else the request's own
// origin. Logs never include the message (it carries invite links). Replies go to the
// person who sent the invite (`reply_to`); `X-Entity-Ref-ID` (the invite's id) keeps Gmail
// from threading separate invites together. The request shape follows a sender that
// works in production (EasySchematic's magic-link email, same Resend account).
import { logError } from "./security";

export const DEFAULT_EMAIL_FROM = "Cuesheet <cuesheet@easyschematic.live>";
const RESEND_URL = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Where replies go: the person who invited or added them (none for account notices). */
  replyTo?: string;
  /** Unique per message (`X-Entity-Ref-ID`), so mail clients don't thread them together. */
  refId: string;
}

type EmailEnv = { RESEND_API_KEY?: string; EMAIL_FROM?: string; APP_ORIGIN?: string };

/**
 * Developer builds only (`vite dev`, and the e2e build with VITE_DEV_PAGES=1): emails that
 * weren't sent because there's no key are kept here (the last 50, in this isolate's memory)
 * for admins at GET /api/dev/outbox, so a developer or the e2e suite can follow their
 * links. A build-time constant: production builds compile it out.
 */
const DEV_OUTBOX = import.meta.env?.DEV === true || import.meta.env?.VITE_DEV_PAGES === "1";
const outbox: EmailMessage[] = [];

/** The developer outbox (oldest first), or null in builds without one. */
export function devOutbox(): readonly EmailMessage[] | null {
  return DEV_OUTBOX ? outbox : null;
}

/** How long a send may take before it counts as failed (it never holds a request longer). */
export const EMAIL_TIMEOUT_MS = 5000;

/**
 * Send one email. True when Resend accepted it; false without a key or on any failure,
 * a timeout (`timeoutMs`, default EMAIL_TIMEOUT_MS) included.
 */
export async function sendEmail(
  env: object,
  message: EmailMessage,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const vars = env as EmailEnv;
  const key = vars.RESEND_API_KEY;
  if (!key) {
    if (DEV_OUTBOX) {
      outbox.push(message);
      if (outbox.length > 50) outbox.shift();
    }
    return false;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? EMAIL_TIMEOUT_MS),
      body: JSON.stringify({
        from: vars.EMAIL_FROM || DEFAULT_EMAIL_FROM,
        to: message.to,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        headers: { "X-Entity-Ref-ID": message.refId },
        text: message.text,
        html: message.html,
      }),
    });
    if (res.ok) return true;
    // Resend's error body ({statusCode, message, name}) is only logged, never parsed.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    logError(`email: Resend answered ${res.status}`, detail);
    return false;
  } catch (e) {
    logError("email: Resend unreachable or too slow", e);
    return false;
  }
}

/** The origin for links in emails: APP_ORIGIN, else the request's. */
export function appOrigin(env: object, requestUrl: string): string {
  const configured = (env as EmailEnv).APP_ORIGIN;
  return (configured || new URL(requestUrl).origin).replace(/\/+$/, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const article = (role: string) => (/^[aeiou]/.test(role) ? "an" : "a");

function html(paragraphs: string[], link: string, label: string): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  const href = escapeHtml(link);
  return `<!doctype html>
<html><body style="font-family: sans-serif; line-height: 1.5;">
${body}
<p><a href="${href}">${escapeHtml(label)}</a></p>
<p style="color: #666; font-size: 0.9em;">Or paste this link into your browser: ${href}</p>
</body></html>`;
}

export interface InviteEmail {
  to: string;
  inviterName: string;
  inviterEmail: string;
  /** The invite's id (the message's X-Entity-Ref-ID). */
  inviteId: string;
  /** The show or team the invite joins. */
  targetName: string;
  targetKind: "show" | "team";
  role: string;
  /** Absolute accept link. */
  link: string;
  expiresAt: number;
}

/** "X invited you to Y on Cuesheet": a sign-up link that joins the show or team. */
export function inviteEmail(e: InviteEmail): EmailMessage {
  const expires = new Date(e.expiresAt).toUTCString();
  const lines = [
    `${e.inviterName} invited you to the ${e.targetKind} ${e.targetName} on Cuesheet, as ${article(e.role)} ${e.role}.`,
    `Set up your account with the link below. It works once and expires ${expires}.`,
  ];
  return {
    to: e.to,
    replyTo: e.inviterEmail,
    refId: e.inviteId,
    subject: `${e.inviterName} invited you to ${e.targetName} on Cuesheet`,
    text: `${lines.join("\n\n")}\n\n${e.link}\n`,
    html: html(lines, e.link, "Accept the invite"),
  };
}

export interface AddedEmail {
  to: string;
  inviterName: string;
  inviterEmail: string;
  targetName: string;
  targetKind: "show" | "team";
  role: string;
  /** Absolute link to the show or team page. */
  link: string;
}

/** "X added you to Y on Cuesheet": an existing account was added to a show or team. */
export function addedEmail(e: AddedEmail): EmailMessage {
  const lines = [
    `${e.inviterName} added you to the ${e.targetKind} ${e.targetName} on Cuesheet, as ${article(e.role)} ${e.role}.`,
  ];
  return {
    to: e.to,
    replyTo: e.inviterEmail,
    refId: crypto.randomUUID(),
    subject: `${e.inviterName} added you to ${e.targetName} on Cuesheet`,
    text: `${lines.join("\n\n")}\n\n${e.link}\n`,
    html: html(lines, e.link, `Open the ${e.targetKind}`),
  };
}

export interface EmailChangeEmail {
  /** The new address (the link proves the account holder controls it). */
  to: string;
  name: string;
  oldEmail: string;
  /** The link's row id (the message's X-Entity-Ref-ID). */
  refId: string;
  /** Absolute confirm link. */
  link: string;
  expiresAt: number;
}

/** "Confirm your new Cuesheet login email": sent to the new address. */
export function emailChangeEmail(e: EmailChangeEmail): EmailMessage {
  const expires = new Date(e.expiresAt).toUTCString();
  const lines = [
    `${e.name} asked to change the login email of their Cuesheet account from ${e.oldEmail} to this address.`,
    `Confirm with the link below. It works once and expires ${expires}. If this wasn't you, ignore this email: nothing changes.`,
  ];
  return {
    to: e.to,
    refId: e.refId,
    subject: "Confirm your new Cuesheet login email",
    text: `${lines.join("\n\n")}\n\n${e.link}\n`,
    html: html(lines, e.link, "Confirm the new email"),
  };
}

export interface EmailChangedEmail {
  /** The old address. */
  to: string;
  name: string;
  newEmail: string;
  /** Absolute link to the app (sign in). */
  link: string;
}

/** "Your Cuesheet login email was changed": the notice to the old address. */
export function emailChangedEmail(e: EmailChangedEmail): EmailMessage {
  const lines = [
    `The login email of your Cuesheet account (${e.name}) was changed from ${e.to} to ${e.newEmail}.`,
    "If this wasn't you, contact your Cuesheet admin.",
  ];
  return {
    to: e.to,
    refId: crypto.randomUUID(),
    subject: "Your Cuesheet login email was changed",
    text: `${lines.join("\n\n")}\n\n${e.link}\n`,
    html: html(lines, e.link, "Open Cuesheet"),
  };
}
