// R24 hardening and deploy plumbing: login rate limiting (time moved by rewriting the
// events' timestamps), sliding sessions, sign out everywhere, password change, admin reset
// links, invites with a show and role, ownership transfer / leaving, health, the owner's
// JSON export, the weekly D1 backup, and security headers.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateResetLinkResponse } from "../../src/shared/account";
import type { CreateInviteResponse, MembersResponse, ShowResponse } from "../../src/shared/api";
import type { ServerMessage } from "../../src/shared/ws";
import { SESSION_TTL_MS } from "../../src/worker/auth/cookie";
import { recordFailure, retryAfter } from "../../src/worker/auth/rate-limit";
import { BACKUP_PREFIX, backupD1, type ShowExport } from "../../src/worker/routes/backup";
import { contentSecurityPolicy, inlineScriptHashes, serveAsset } from "../../src/worker/security";
import {
  ADMIN,
  api,
  collect,
  createShow,
  isType,
  loginAdmin,
  newUser,
  post,
  sessionCookie,
  WS_HEADERS,
} from "./helpers";

const PASSWORD = "long-enough-pw";

function login(email: string, password: string, ip = "198.51.100.1") {
  return api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "CF-Connecting-IP": ip },
  });
}

async function openSocket(showId: string, cookie: string) {
  const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
  expect(res.status).toBe(101);
  const s = collect(res.webSocket as WebSocket);
  await s.next(isType("hello"));
  return s;
}

/** Move a key's rate-limit events `ms` into the past. */
async function age(keyLike: string, ms: number) {
  await env.DB.prepare("UPDATE rate_limit_events SET at = at - ?1 WHERE key LIKE ?2")
    .bind(ms, keyLike)
    .run();
}

describe("rate limiting", () => {
  it("slides: 10 a minute, 50 an hour, per key", async () => {
    const db = env.DB;
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) await recordFailure(db, ["k:a"], t0 + i * 1000);
    expect(await retryAfter(db, ["k:a"], t0 + 10_000)).toBe(50); // the first leaves at t0+60s
    expect(await retryAfter(db, ["k:b"], t0 + 10_000)).toBe(0);
    expect(await retryAfter(db, ["k:a"], t0 + 60_001)).toBe(0);
    // 50 an hour, spread so no minute holds 10.
    for (let i = 10; i < 50; i++) await recordFailure(db, ["k:a"], t0 + i * 61_000);
    const later = t0 + 50 * 61_000;
    expect(await retryAfter(db, ["k:a"], later)).toBeGreaterThan(0);
    expect(await retryAfter(db, ["k:a"], t0 + 3_600_001 + 10 * 61_000)).toBe(0);
  });

  it("locks an email after 10 failed logins (429 + Retry-After), whatever the IP; then frees it", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Locked");
    for (let i = 0; i < 10; i++) {
      const res = await login(user.email, "wrong-password!", `198.51.100.${i + 10}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Wrong email or password" });
    }
    const blocked = await login(user.email, PASSWORD, "198.51.100.99");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Too many attempts/);
    // An unknown email gets the same treatment (no account enumeration).
    for (let i = 0; i < 10; i++) await login("nobody@test.local", "x", `198.51.100.${i + 30}`);
    expect((await login("nobody@test.local", "x", "198.51.100.98")).status).toBe(429);
    // A minute later the window has room again.
    await age(`login:email:${user.email}`, 61_000);
    expect((await login(user.email, PASSWORD, "198.51.100.97")).status).toBe(200);
  });

  it("locks an IP after 10 failures across emails", async () => {
    const ip = "198.51.100.200";
    for (let i = 0; i < 10; i++) {
      expect((await login(`guess${i}@test.local`, "nope-nope-nope", ip)).status).toBe(401);
    }
    expect((await login(ADMIN.email, ADMIN.password, ip)).status).toBe(429);
    expect((await login(ADMIN.email, ADMIN.password, "198.51.100.201")).status).toBe(200);
  });

  it("rate-limits bad invite tokens per IP", async () => {
    const headers = { "CF-Connecting-IP": "198.51.100.150" };
    for (let i = 0; i < 10; i++) {
      expect((await api(`/api/invites/bad-${i}`, { headers })).status).toBe(404);
    }
    expect((await api("/api/invites/bad-x", { headers })).status).toBe(429);
    const accept = await api("/api/invites/bad-y/accept", {
      method: "POST",
      body: JSON.stringify({ name: "X", password: PASSWORD }),
      headers,
    });
    expect(accept.status).toBe(429);
  });
});

describe("sessions", () => {
  it("slide: a session used after a day gets 30 fresh days and a fresh cookie", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Slider");
    let res = await api("/api/shows", { cookie: user.cookie });
    expect(res.headers.get("Set-Cookie")).toBeNull(); // fresh: nothing to do
    const soon = Date.now() + 10 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .bind(soon, user.id)
      .run();
    res = await api("/api/shows", { cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=2592000/);
    const row = await env.DB.prepare("SELECT expires_at AS e FROM sessions WHERE user_id = ?")
      .bind(user.id)
      .first<{ e: number }>();
    expect(row?.e).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });

  it("sign out everywhere ends every session and closes every socket", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Everywhere");
    const show = await createShow(admin, "Signout");
    await post(`/api/shows/${show.id}/members`, { email: user.email, role: "editor" }, admin);
    const second = sessionCookie(await login(user.email, PASSWORD));
    const a = await openSocket(show.id, user.cookie);
    const b = await openSocket(show.id, second);
    const adminSocket = await openSocket(show.id, admin);

    const res = await post("/api/auth/logout-all", {}, user.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await a.closedWith()).toBe(4003);
    expect(await b.closedWith()).toBe(4003);
    for (const cookie of [user.cookie, second]) {
      expect((await api("/api/shows", { cookie })).status).toBe(401);
    }
    // Other users are untouched.
    expect((await api("/api/shows", { cookie: admin })).status).toBe(200);
    expect(adminSocket.ws.readyState).toBe(WebSocket.OPEN);
    adminSocket.ws.close();
    expect((await post("/api/auth/logout-all", {})).status).toBe(401);
  });

  it("password change: checks the current one, ≥ 10 characters, signs out the other sessions", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Changer");
    const show = await createShow(admin, "Pw");
    await post(`/api/shows/${show.id}/members`, { email: user.email, role: "viewer" }, admin);
    const other = sessionCookie(await login(user.email, PASSWORD));
    const mine = await openSocket(show.id, user.cookie);
    const theirs = await openSocket(show.id, other);

    const change = (currentPassword: string, newPassword: string) =>
      post("/api/auth/password", { currentPassword, newPassword }, user.cookie);
    expect((await change(PASSWORD, "short")).status).toBe(400);
    const wrong = await change("not-my-password", "a-new-long-password");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "The current password is wrong" });
    const ok = await change(PASSWORD, "a-new-long-password");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, sessionsEnded: 1 });

    expect(await theirs.closedWith()).toBe(4003);
    expect((await api("/api/shows", { cookie: other })).status).toBe(401);
    expect((await api("/api/shows", { cookie: user.cookie })).status).toBe(200);
    expect(mine.ws.readyState).toBe(WebSocket.OPEN);
    mine.ws.close();
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, "a-new-long-password")).status).toBe(200);
  });

  it("admin reset links: admins only, one-time, set the password and sign out everywhere", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Forgetful");
    expect(
      (await post("/api/admin/password-resets", { email: user.email }, user.cookie)).status,
    ).toBe(403);
    expect(
      (await post("/api/admin/password-resets", { email: "ghost@test.local" }, admin)).status,
    ).toBe(404);
    const made = await post("/api/admin/password-resets", { email: user.email }, admin);
    expect(made.status).toBe(201);
    const reset = (await made.json()) as CreateResetLinkResponse;
    expect(reset.path).toMatch(/^\/reset\/[A-Za-z0-9_-]{40,}$/);
    const token = reset.path.split("/").at(-1) as string;
    // A reset link isn't an invite.
    expect((await api(`/api/invites/${token}`)).status).toBe(404);
    expect(await (await api(`/api/password-resets/${token}`)).json()).toEqual({
      email: user.email,
    });
    expect((await post(`/api/password-resets/${token}`, { password: "short" })).status).toBe(400);
    const done = await post(`/api/password-resets/${token}`, { password: "brand-new-password" });
    expect(done.status).toBe(200);
    const fresh = sessionCookie(done);
    expect((await api("/api/shows", { cookie: user.cookie })).status).toBe(401);
    expect((await api("/api/shows", { cookie: fresh })).status).toBe(200);
    expect(
      (await post(`/api/password-resets/${token}`, { password: "again-and-again" })).status,
    ).toBe(404);
    expect((await login(user.email, "brand-new-password")).status).toBe(200);
  });
});

describe("invites and members", () => {
  it("invites carry a show and role; show owners may invite to their show", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Invited");
    const res = await post(
      "/api/invites",
      { email: "joiner@test.local", showId: show.id, role: "commenter" },
      admin,
    );
    expect(res.status).toBe(201);
    const token = ((await res.json()) as CreateInviteResponse).path.split("/").at(-1) as string;
    expect(await (await api(`/api/invites/${token}`)).json()).toEqual({
      email: "joiner@test.local",
      showName: "Invited",
      role: "commenter",
    });
    const accepted = await post(`/api/invites/${token}/accept`, {
      name: "Joiner",
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    const joiner = sessionCookie(accepted);
    const info = (await (
      await api(`/api/shows/${show.id}`, { cookie: joiner })
    ).json()) as ShowResponse;
    expect(info.role).toBe("commenter");

    // An owner who isn't an admin: their own show only.
    const owner = await newUser(admin, "Owner");
    const own = await createShow(owner.cookie, "Mine");
    expect(
      (await post("/api/invites", { email: "a@test.local", showId: own.id }, owner.cookie)).status,
    ).toBe(201);
    expect((await post("/api/invites", { email: "b@test.local" }, owner.cookie)).status).toBe(403);
    expect(
      (await post("/api/invites", { email: "c@test.local", showId: show.id }, owner.cookie)).status,
    ).toBe(403);
    expect(
      (
        await post(
          "/api/invites",
          { email: "d@test.local", showId: own.id, role: "owner" },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
  });

  it("transfers ownership (owner only) and lets non-owners leave", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Handover");
    const editor = await newUser(admin, "Next owner");
    const viewer = await newUser(admin, "Leaver");
    for (const [u, role] of [
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const) {
      await post(`/api/shows/${show.id}/members`, { email: u.email, role }, admin);
    }
    expect((await post(`/api/shows/${show.id}/leave`, {}, admin)).status).toBe(400);
    expect(
      (await post(`/api/shows/${show.id}/transfer`, { userId: viewer.id }, editor.cookie)).status,
    ).toBe(403);
    expect((await post(`/api/shows/${show.id}/transfer`, { userId: "nobody" }, admin)).status).toBe(
      404,
    );
    const socket = await openSocket(show.id, editor.cookie);
    expect(
      (await post(`/api/shows/${show.id}/transfer`, { userId: editor.id }, admin)).status,
    ).toBe(200);
    expect(await socket.next(isType("role"))).toEqual({ type: "role", role: "owner" });
    socket.ws.close();
    const members = (await (
      await api(`/api/shows/${show.id}/members`, { cookie: admin })
    ).json()) as MembersResponse;
    const roles = Object.fromEntries(members.members.map((m) => [m.name, m.role]));
    expect(roles).toMatchObject({ Admin: "editor", "Next owner": "owner", Leaver: "viewer" });

    const leaving = await openSocket(show.id, viewer.cookie);
    expect((await post(`/api/shows/${show.id}/leave`, {}, viewer.cookie)).status).toBe(200);
    expect(await leaving.closedWith()).toBe(4003);
    expect((await api(`/api/shows/${show.id}`, { cookie: viewer.cookie })).status).toBe(404);
  });

  it("counts viewers' sockets as read-only in presence", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Presence");
    const viewer = await newUser(admin, "Watcher");
    await post(`/api/shows/${show.id}/members`, { email: viewer.email, role: "viewer" }, admin);
    const mine = await openSocket(show.id, admin);
    const theirs = await openSocket(show.id, viewer.cookie);
    expect(await mine.next(isType("presence"))).toEqual({
      type: "presence",
      clients: 2,
      readOnly: 1,
    });
    await api(`/api/shows/${show.id}/members/${viewer.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "editor" }),
      cookie: admin,
    });
    expect(
      await mine.next((m): m is ServerMessage => m.type === "presence" && m.readOnly === 0),
    ).toBeTruthy();
    mine.ws.close();
    theirs.ws.close();
  });
});

describe("health, export, backups, headers", () => {
  it("GET /api/health checks D1 and a Durable Object", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, d1: true, do: true });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("export.json: the owner gets everything; editors don't", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Exported");
    const editor = await newUser(admin, "Ed");
    await post(`/api/shows/${show.id}/members`, { email: editor.email, role: "editor" }, admin);
    expect((await api(`/api/shows/${show.id}/export.json`, { cookie: editor.cookie })).status).toBe(
      403,
    );
    expect((await api(`/api/shows/${show.id}/export.json`)).status).toBe(401);
    const res = await api(`/api/shows/${show.id}/export.json`, { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="Exported-/);
    const out = (await res.json()) as ShowExport;
    expect(out).toMatchObject({
      format: "cuesheet-show-export",
      version: 1,
      show: { id: show.id, name: "Exported" },
    });
    expect(out.members.map((m) => m.role).sort()).toEqual(["editor", "owner"]);
    expect(out.snapshot.tables.views.length).toBeGreaterThan(0);
    expect(out.files).toEqual([]);
  });

  it("backs D1 up to R2 as gzipped JSON, without sessions, keeping the newest 13", async () => {
    await loginAdmin();
    for (let i = 0; i < 15; i++) {
      await backupD1(env, new Date(Date.UTC(2026, 0, 1 + i * 7, 3, 17)));
    }
    const listed = await env.FILES.list({ prefix: BACKUP_PREFIX });
    expect(listed.objects).toHaveLength(13);
    const newest = listed.objects
      .map((o) => o.key)
      .sort()
      .at(-1) as string;
    expect(newest).toContain("2026-04-09"); // Jan 1 + 14 weeks
    const obj = await env.FILES.get(newest);
    const json = JSON.parse(
      await new Response(
        (obj as R2ObjectBody).body.pipeThrough(new DecompressionStream("gzip")),
      ).text(),
    ) as { format: string; tables: Record<string, unknown[]> };
    expect(json.format).toBe("cuesheet-d1-backup");
    expect(json.tables.users?.length).toBeGreaterThan(0);
    expect(json.tables.sessions).toBeUndefined();
    expect(json.tables.rate_limit_events).toBeUndefined();
  });

  it("pages get a CSP that allows exactly their inline scripts", async () => {
    const html = `<!doctype html><html><head><script>var a = 1;</script><script type="module" src="/assets/x.js"></script></head><body></body></html>`;
    const hashes = await inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    const assets = {
      fetch: async () => new Response(html, { headers: { "Content-Type": "text/html" } }),
    } as unknown as Fetcher;
    const res = await serveAsset(new Request("https://cuesheet.example/shows/x"), assets, {
      csp: true,
    });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(contentSecurityPolicy("cuesheet.example", hashes));
    expect(csp).toContain(hashes[0]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await res.text()).toBe(html);
    // Other files: no CSP, but the base headers.
    const js = await serveAsset(
      new Request("http://localhost/robots.txt"),
      {
        fetch: async () => new Response("x", { headers: { "Content-Type": "text/plain" } }),
      } as unknown as Fetcher,
      { csp: true },
    );
    expect(js.headers.get("Content-Security-Policy")).toBeNull();
    expect(js.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(js.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("production cookies are always Secure", async () => {
    const { isHttps } = await import("../../src/worker/routes/util");
    const ctx = (url: string, ENVIRONMENT: string) =>
      ({ req: { url }, env: { ENVIRONMENT } }) as unknown as Parameters<typeof isHttps>[0];
    expect(isHttps(ctx("http://x/api", "development"))).toBe(false);
    expect(isHttps(ctx("https://x/api", "development"))).toBe(true);
    expect(isHttps(ctx("http://x/api", "production"))).toBe(true);
  });
});
