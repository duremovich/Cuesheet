// Account settings: the display name (PATCH /api/me) and changing the login email
// (POST /api/me/email → a link to the new address → POST /api/email-changes/:token).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  ChangeEmailResponse,
  ConfirmEmailChangeResponse,
  EmailChangeInfoResponse,
} from "../../src/shared/account";
import type { MeResponse, MyAccessResponse } from "../../src/shared/api";
import {
  api,
  collect,
  createShow,
  isType,
  loginAdmin,
  newUser,
  post,
  type SentEmail,
  stubResend,
  WS_HEADERS,
} from "./helpers";

const PASSWORD = "long-enough-pw";

function send(method: string, path: string, cookie: string | undefined, body?: unknown) {
  return api(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(cookie ? { cookie } : {}),
  });
}

function login(email: string, password = PASSWORD, ip = "203.0.113.50") {
  return api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "CF-Connecting-IP": ip },
  });
}

let seq = 0;
const freshEmail = (label: string) => `${label}${Date.now().toString(36)}${seq++}@new.test`;

/** The confirmation token in a sent email (its link ends in /confirm-email/<token>). */
function tokenIn(mail: SentEmail | undefined): string {
  const m = /\/confirm-email\/([A-Za-z0-9_-]+)/.exec(mail?.body.text ?? "");
  if (!m?.[1]) throw new Error(`no confirmation link in ${JSON.stringify(mail?.body.text)}`);
  return m[1];
}

/** Request a change to `newEmail` with email on; returns the response and the link's token. */
async function requestChange(cookie: string, newEmail: string) {
  const resend = stubResend();
  try {
    const res = await post("/api/me/email", { newEmail, currentPassword: PASSWORD }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangeEmailResponse;
    return { body, token: tokenIn(resend.sent[0]), sent: resend.sent };
  } finally {
    resend.restore();
  }
}

function confirm(token: string, ip = "203.0.113.60") {
  return api(`/api/email-changes/${token}`, {
    method: "POST",
    body: "{}",
    headers: { "CF-Connecting-IP": ip },
  });
}

async function myAccess(cookie: string) {
  const res = await api("/api/me/access", { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as MyAccessResponse;
}

describe("display name", () => {
  it("PATCH /api/me trims and validates like invite accept, and returns the user", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Old Name");
    for (const name of ["", "   ", "x".repeat(201), 42]) {
      const bad = await send("PATCH", "/api/me", u.cookie, { name });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "Enter your name" });
    }
    const res = await send("PATCH", "/api/me", u.cookie, { name: "  New Name  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).user).toEqual({
      id: u.id,
      email: u.email,
      name: "New Name",
      isAdmin: false,
    });
    const me = (await (await api("/api/me", { cookie: u.cookie })).json()) as MeResponse;
    expect(me.user.name).toBe("New Name");
    expect((await send("PATCH", "/api/me", undefined, { name: "Nobody" })).status).toBe(401);
  });

  it("open shows' presence lists pick up the new name at once", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Before");
    const show = await createShow(admin, "Rename presence");
    await post(`/api/shows/${show.id}/members`, { email: u.email, role: "editor" }, admin);
    const res = await api(`/api/shows/${show.id}/ws`, { cookie: admin, headers: WS_HEADERS });
    const watcher = collect(res.webSocket as WebSocket);
    const theirs = collect(
      (await api(`/api/shows/${show.id}/ws`, { cookie: u.cookie, headers: WS_HEADERS }))
        .webSocket as WebSocket,
    );
    await watcher.next(
      (m): m is Extract<typeof m, { type: "presence" }> => m.type === "presence" && m.clients === 2,
    );
    expect((await send("PATCH", "/api/me", u.cookie, { name: "After" })).status).toBe(200);
    const p = await watcher.next(
      (m): m is Extract<typeof m, { type: "presence" }> =>
        isType("presence")(m) && !!m.users?.some((x) => x.id === u.id && x.name === "After"),
    );
    expect(p.clients).toBe(2);
    watcher.ws.close();
    theirs.ws.close();
  });
});

describe("changing the login email", () => {
  it("requires the current password, rate-limited like a password change", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Wrong pw");
    const target = freshEmail("wrongpw");
    const resend = stubResend();
    try {
      const wrong = await post(
        "/api/me/email",
        { newEmail: target, currentPassword: "not-the-password" },
        u.cookie,
      );
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toEqual({ error: "The current password is wrong" });
      // The same per-account key as a password change: 10 failures lock both.
      for (let i = 0; i < 9; i++) {
        await post(
          "/api/me/email",
          { newEmail: target, currentPassword: "not-the-password" },
          u.cookie,
        );
      }
      const locked = await post(
        "/api/me/email",
        { newEmail: target, currentPassword: PASSWORD },
        u.cookie,
      );
      expect(locked.status).toBe(429);
      expect(locked.headers.get("Retry-After")).toBeTruthy();
      const pw = await post(
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "another-long-pw" },
        u.cookie,
      );
      expect(pw.status).toBe(429);
      expect(resend.sent).toHaveLength(0);
    } finally {
      resend.restore();
    }
  });

  it("rejects a bad address, your own address (400) and one another account uses (409)", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Picky");
    const other = await newUser(admin, "Other");
    const resend = stubResend();
    try {
      const change = (newEmail: string) =>
        post("/api/me/email", { newEmail, currentPassword: PASSWORD }, u.cookie);
      expect((await change("not-an-email")).status).toBe(400);
      const same = await change(`  ${u.email.toUpperCase()} `);
      expect(same.status).toBe(400);
      expect(await same.json()).toEqual({ error: "That's already your login email" });
      const taken = await change(other.email.toUpperCase());
      expect(taken.status).toBe(409);
      expect(await taken.json()).toEqual({ error: "Another account already uses that email" });
      expect(resend.sent).toHaveLength(0);
      expect((await myAccess(u.cookie)).pendingEmail).toBeNull();
    } finally {
      resend.restore();
    }
  });

  it("emails a 24 h link to the new address; confirming switches the login and tells the old address", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Mover");
    const target = freshEmail("Mover").toUpperCase();
    const before = Date.now();
    const { body, token, sent } = await requestChange(u.cookie, ` ${target} `);
    const newEmail = target.toLowerCase();
    expect(body.emailed).toBe(true);
    expect(body.pending.email).toBe(newEmail);
    expect(body.pending.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(body.pending.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.to).toBe(newEmail);
    expect(sent[0]?.body.text).toContain(`http://localhost/confirm-email/${token}`);
    expect(sent[0]?.body.html).toContain(`/confirm-email/${token}`);
    // Only the hash is stored.
    const raw = await env.DB.prepare(
      "SELECT id, kind, user_id, email FROM invites WHERE kind = ?1 AND user_id = ?2",
    )
      .bind("email", u.id)
      .all<{ id: string; kind: string; user_id: string; email: string }>();
    expect(raw.results).toHaveLength(1);
    expect(raw.results[0]?.id).not.toContain(token);
    expect(raw.results[0]?.email).toBe(newEmail);

    // The pending change is listed; nothing has changed yet.
    expect((await myAccess(u.cookie)).pendingEmail).toEqual(body.pending);
    expect((await login(u.email)).status).toBe(200);

    // The link alone is enough (no session): it names the new address, then confirms.
    const info = await api(`/api/email-changes/${token}`, {
      headers: { "CF-Connecting-IP": "203.0.113.61" },
    });
    expect(info.status).toBe(200);
    expect((await info.json()) as EmailChangeInfoResponse).toEqual({ email: newEmail });
    const resend = stubResend();
    try {
      const done = await confirm(token);
      expect(done.status).toBe(200);
      expect((await done.json()) as ConfirmEmailChangeResponse).toEqual({ email: newEmail });
      // The old address hears about it.
      expect(resend.sent).toHaveLength(1);
      expect(resend.sent[0]?.body.to).toBe(u.email);
      expect(resend.sent[0]?.body.text).toContain(newEmail);
      expect(resend.sent[0]?.body.text).toContain("contact");
    } finally {
      resend.restore();
    }

    // Sign-in works with the new address only; the existing session carries on.
    expect((await login(newEmail)).status).toBe(200);
    expect((await login(u.email, PASSWORD, "203.0.113.51")).status).toBe(401);
    const me = (await (await api("/api/me", { cookie: u.cookie })).json()) as MeResponse;
    expect(me.user.email).toBe(newEmail);
    expect((await myAccess(u.cookie)).pendingEmail).toBeNull();
  });

  it("a used, expired or revoked link is refused with the same message", async () => {
    const admin = await loginAdmin();
    const bad = { error: "This confirmation link is invalid, expired or has been used" };

    // Used.
    const a = await newUser(admin, "Used");
    const used = await requestChange(a.cookie, freshEmail("used"));
    expect((await confirm(used.token, "203.0.113.70")).status).toBe(200);
    const again = await confirm(used.token, "203.0.113.70");
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual(bad);

    // Expired.
    const b = await newUser(admin, "Expired");
    const expired = await requestChange(b.cookie, freshEmail("expired"));
    await env.DB.prepare("UPDATE invites SET expires_at = ?1 WHERE kind = 'email' AND user_id = ?2")
      .bind(Date.now() - 1, b.id)
      .run();
    const late = await confirm(expired.token, "203.0.113.71");
    expect(late.status).toBe(404);
    expect(await late.json()).toEqual(bad);
    const lateInfo = await api(`/api/email-changes/${expired.token}`, {
      headers: { "CF-Connecting-IP": "203.0.113.71" },
    });
    expect(lateInfo.status).toBe(404);
    expect((await myAccess(b.cookie)).pendingEmail).toBeNull();

    // Revoked (cancelled).
    const c = await newUser(admin, "Revoked");
    const revoked = await requestChange(c.cookie, freshEmail("revoked"));
    expect((await myAccess(c.cookie)).pendingEmail).not.toBeNull();
    const cancel = await send("DELETE", "/api/me/email", c.cookie);
    expect(cancel.status).toBe(200);
    expect((await myAccess(c.cookie)).pendingEmail).toBeNull();
    const dead = await confirm(revoked.token, "203.0.113.72");
    expect(dead.status).toBe(404);
    expect(await dead.json()).toEqual(bad);
    // Nothing changed for either of them.
    expect((await login(b.email, PASSWORD, "203.0.113.73")).status).toBe(200);
    expect((await login(c.email, PASSWORD, "203.0.113.73")).status).toBe(200);
  });

  it("bad tokens are rate-limited per IP", async () => {
    const ip = "203.0.113.80";
    for (let i = 0; i < 10; i++) {
      expect((await confirm(`nope${i}`, ip)).status).toBe(404);
    }
    expect((await confirm("nope-again", ip)).status).toBe(429);
    const info = await api("/api/email-changes/whatever", { headers: { "CF-Connecting-IP": ip } });
    expect(info.status).toBe(429);
  });

  it("an address taken between request and confirm: 409, nothing changes, the link stays pending", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Racer");
    const target = freshEmail("race");
    const { token } = await requestChange(u.cookie, target);
    // Someone else signs up with that address meanwhile.
    const invite = (await (await post("/api/invites", { email: target }, admin)).json()) as {
      path: string;
    };
    const accepted = await post(`/api/invites/${invite.path.split("/").at(-1)}/accept`, {
      name: "Squatter",
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    const res = await confirm(token, "203.0.113.90");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Another account already uses that email" });
    expect((await login(u.email, PASSWORD, "203.0.113.91")).status).toBe(200);
    const me = (await (await api("/api/me", { cookie: u.cookie })).json()) as MeResponse;
    expect(me.user.email).toBe(u.email);
  });

  it("a second request revokes the first; resend replaces the link; cancel ends it", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Twice");
    const first = await requestChange(u.cookie, freshEmail("first"));
    const secondEmail = freshEmail("second");
    const second = await requestChange(u.cookie, secondEmail);
    expect((await myAccess(u.cookie)).pendingEmail?.email).toBe(secondEmail);
    expect((await confirm(first.token, "203.0.113.100")).status).toBe(404);

    // Resend: a new link to the same pending address (no password); the previous one dies.
    const resend = stubResend();
    let third = "";
    try {
      const res = await post("/api/me/email/resend", {}, u.cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChangeEmailResponse;
      expect(body).toMatchObject({ emailed: true, pending: { email: secondEmail } });
      expect(resend.sent[0]?.body.to).toBe(secondEmail);
      third = tokenIn(resend.sent[0]);
    } finally {
      resend.restore();
    }
    expect(third).not.toBe(second.token);
    expect((await confirm(second.token, "203.0.113.100")).status).toBe(404);

    // Cancel: no pending change, the link dies, resend has nothing to send.
    expect((await send("DELETE", "/api/me/email", u.cookie)).status).toBe(200);
    expect((await myAccess(u.cookie)).pendingEmail).toBeNull();
    expect((await confirm(third, "203.0.113.100")).status).toBe(404);
    const nothing = await post("/api/me/email/resend", {}, u.cookie);
    expect(nothing.status).toBe(404);
  });

  it("says plainly when the email didn't go out (not configured, or the send failed)", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "No mail");
    const target = freshEmail("nomail");
    // No RESEND_API_KEY in tests: nothing is sent.
    const res = await post(
      "/api/me/email",
      { newEmail: target, currentPassword: PASSWORD },
      u.cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangeEmailResponse;
    expect(body.emailed).toBe(false);
    expect(body.message).toMatch(/isn't set up/);
    expect(body.pending.email).toBe(target);
    // No link anywhere in the response: only the new address may confirm.
    expect(JSON.stringify(body)).not.toContain("/confirm-email/");

    const failing = stubResend({ fail: "status" });
    try {
      const again = await post("/api/me/email/resend", {}, u.cookie);
      expect(again.status).toBe(200);
      const b = (await again.json()) as ChangeEmailResponse;
      expect(b.emailed).toBe(false);
      expect(b.message).toMatch(/couldn't be sent/);
    } finally {
      failing.restore();
    }
  });

  it("the developer outbox (dev and e2e builds): admins only, unsent mail only", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Outbox");
    expect((await api("/api/dev/outbox", { cookie: u.cookie })).status).toBe(403);
    expect((await api("/api/dev/outbox")).status).toBe(401);
    const target = freshEmail("outbox");
    await post("/api/me/email", { newEmail: target, currentPassword: PASSWORD }, u.cookie);
    const res = await api(`/api/dev/outbox?to=${encodeURIComponent(target)}`, { cookie: admin });
    // Vitest runs the Worker as a dev build (import.meta.env.DEV), so the outbox is on.
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: { to: string; text: string }[] };
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toMatch(/\/confirm-email\/[A-Za-z0-9_-]+/);
  });

  it("caps the confirmation emails one account may trigger", async () => {
    const admin = await loginAdmin();
    const u = await newUser(admin, "Spammer");
    const resend = stubResend();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await post(
          "/api/me/email",
          { newEmail: freshEmail(`spam${i}`), currentPassword: PASSWORD },
          u.cookie,
        );
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      expect((await post("/api/me/email/resend", {}, u.cookie)).status).toBe(429);
      expect(resend.sent).toHaveLength(5);
    } finally {
      resend.restore();
    }
  });
});
