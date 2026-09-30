// The /api surface end to end inside workerd (D1 + DO), without a browser.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  CreateInviteResponse,
  MeResponse,
  ShowResponse,
  ShowSummaryDTO,
  ShowsResponse,
} from "../../src/shared/api";
import { DEFAULT_ITERATIONS, hashPassword } from "../../src/worker/auth/password";

const ADMIN = { email: "admin@test.local", password: "test-password-123" };
/** A same-origin browser WebSocket handshake (requests below go to http://localhost). */
const WS_HEADERS = { Upgrade: "websocket", Origin: "http://localhost" };

async function api(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.cookie) headers.set("Cookie", init.cookie);
  return exports.default.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

function post(path: string, body: unknown, cookie?: string) {
  return api(path, { method: "POST", body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });
}

function sessionCookie(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  const pair = set.split(";")[0] ?? "";
  expect(pair).toMatch(/^cs_session=.+/);
  return pair;
}

async function loginAdmin(): Promise<string> {
  const res = await post("/api/auth/login", ADMIN);
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

describe("API", () => {
  it("GET /api/health", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects cross-site form posts (CSRF)", async () => {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: "email=a&password=b",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });

  it("unknown API routes are JSON 404s", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("seeds the admin, logs in with a secure cookie, and logs out", async () => {
    expect(await (await api("/api/me")).json()).toEqual({ user: null });
    expect((await post("/api/auth/login", { ...ADMIN, password: "wrong" })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "nobody@x.io", password: "x" })).status).toBe(
      401,
    );

    const res = await post("/api/auth/login", { ...ADMIN, email: " Admin@Test.Local " });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = sessionCookie(res);

    const me = (await (await api("/api/me", { cookie })).json()) as MeResponse;
    expect(me.user).toMatchObject({ email: ADMIN.email, isAdmin: true });

    const out = await post("/api/auth/logout", {}, cookie);
    expect(out.status).toBe(200);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const after = await api("/api/me", { cookie });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ user: null });
  });

  it("creates shows, lists them, and proxies GET /api/shows/:id to the DO", async () => {
    const cookie = await loginAdmin();
    expect((await post("/api/shows", { name: "   " }, cookie)).status).toBe(400);
    expect((await post("/api/shows", { name: "x" })).status).toBe(401);

    const created = await post("/api/shows", { name: "Some Like It Hot" }, cookie);
    expect(created.status).toBe(201);
    const { show } = (await created.json()) as { show: ShowSummaryDTO };
    expect(show).toMatchObject({ name: "Some Like It Hot", role: "owner" });

    const list = (await (await api("/api/shows", { cookie })).json()) as ShowsResponse;
    expect(list.shows.map((s) => s.id)).toContain(show.id);

    const one = (await (await api(`/api/shows/${show.id}`, { cookie })).json()) as ShowResponse;
    expect(one).toMatchObject({
      show: { showId: show.id, name: "Some Like It Hot" },
      role: "owner",
    });
  });

  it("re-hashes a password stored with old parameters on successful login", async () => {
    await loginAdmin(); // ensure the admin is seeded
    const old = await hashPassword(ADMIN.password, 1_000);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE email = ?")
      .bind(old, ADMIN.email)
      .run();
    await loginAdmin();
    const row = await env.DB.prepare("SELECT password_hash AS h FROM users WHERE email = ?")
      .bind(ADMIN.email)
      .first<{ h: string }>();
    expect(row?.h.startsWith(`pbkdf2$${DEFAULT_ITERATIONS}$`)).toBe(true);
    await loginAdmin(); // still works with the new hash
  });

  it("treats D1 shows.name as the source of truth and refreshes the DO cache", async () => {
    const cookie = await loginAdmin();
    const { show } = (await (await post("/api/shows", { name: "Before" }, cookie)).json()) as {
      show: ShowSummaryDTO;
    };
    // Rename in D1 only (as a future rename endpoint would), then open the show.
    await env.DB.prepare("UPDATE shows SET name = ? WHERE id = ?").bind("After", show.id).run();
    const one = (await (await api(`/api/shows/${show.id}`, { cookie })).json()) as ShowResponse;
    expect(one.show.name).toBe("After");
    const stub = env.SHOW.get(env.SHOW.idFromName(show.id));
    expect((await stub.getMeta())?.name).toBe("After");
  });

  it("requires membership for a show and its WebSocket", async () => {
    const admin = await loginAdmin();
    const { show } = (await (await post("/api/shows", { name: "Private" }, admin)).json()) as {
      show: ShowSummaryDTO;
    };

    // Invite a second user; they are not a member of the admin's show.
    const invite = (await (
      await post("/api/invites", { email: "member@test.local" }, admin)
    ).json()) as CreateInviteResponse;
    const token = invite.path.split("/").at(-1) as string;
    const accepted = await post(`/api/invites/${token}/accept`, {
      name: "Member",
      password: "member-password-1",
    });
    const other = sessionCookie(accepted);

    expect((await api(`/api/shows/${show.id}`, { cookie: other })).status).toBe(404);
    expect(
      (await api(`/api/shows/${show.id}/ws`, { cookie: other, headers: WS_HEADERS })).status,
    ).toBe(404);
    expect((await api("/api/shows/does-not-exist", { cookie: admin })).status).toBe(404);
    const list = (await (await api("/api/shows", { cookie: other })).json()) as ShowsResponse;
    expect(list.shows).toEqual([]);
  });

  it("upgrades /api/shows/:id/ws for members and says hello", async () => {
    const cookie = await loginAdmin();
    const { show } = (await (await post("/api/shows", { name: "Live" }, cookie)).json()) as {
      show: ShowSummaryDTO;
    };
    expect((await api(`/api/shows/${show.id}/ws`, { cookie })).status).toBe(426);

    const res = await api(`/api/shows/${show.id}/ws`, { cookie, headers: WS_HEADERS });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    const first = new Promise<unknown>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true }),
    );
    ws.accept();
    expect(await first).toEqual({ type: "hello", showId: show.id, clients: 1 });
    ws.close(1000, "done");
  });

  it("refuses WebSocket upgrades from a foreign or missing Origin, even with a valid cookie", async () => {
    const cookie = await loginAdmin();
    const { show } = (await (await post("/api/shows", { name: "Hijack" }, cookie)).json()) as {
      show: ShowSummaryDTO;
    };
    const url = `/api/shows/${show.id}/ws`;
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "null"]) {
      const res = await api(url, { cookie, headers: { Upgrade: "websocket", Origin: origin } });
      expect(res.status, origin).toBe(403);
      expect(res.webSocket).toBeNull();
    }
    const noOrigin = await api(url, { cookie, headers: { Upgrade: "websocket" } });
    expect(noOrigin.status).toBe(403);
  });

  it("invites: admin-only, one-time, and the new user is signed in", async () => {
    const admin = await loginAdmin();
    expect((await post("/api/invites", { email: "not-an-email" }, admin)).status).toBe(400);
    expect((await post("/api/invites", { email: ADMIN.email }, admin)).status).toBe(409);

    const created = await post("/api/invites", { email: "New.Person@Test.Local" }, admin);
    expect(created.status).toBe(201);
    const invite = (await created.json()) as CreateInviteResponse;
    expect(invite.email).toBe("new.person@test.local");
    expect(invite.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{40,}$/);
    const token = invite.path.split("/").at(-1) as string;

    expect(await (await api(`/api/invites/${token}`)).json()).toEqual({
      email: "new.person@test.local",
    });
    expect(
      (await post(`/api/invites/${token}/accept`, { name: "New", password: "short" })).status,
    ).toBe(400);

    const accepted = await post(`/api/invites/${token}/accept`, {
      name: "New Person",
      password: "long-enough-pw",
    });
    expect(accepted.status).toBe(201);
    const cookie = sessionCookie(accepted);
    const me = (await (await api("/api/me", { cookie })).json()) as MeResponse;
    expect(me.user).toMatchObject({ email: "new.person@test.local", isAdmin: false });

    // One-time: the link is dead now.
    expect((await api(`/api/invites/${token}`)).status).toBe(404);
    expect(
      (await post(`/api/invites/${token}/accept`, { name: "Again", password: "long-enough-pw" }))
        .status,
    ).toBe(404);

    // Non-admins can't invite.
    expect((await post("/api/invites", { email: "x@test.local" }, cookie)).status).toBe(403);
    // And the new user can log in with their password.
    expect(
      (
        await post("/api/auth/login", {
          email: "new.person@test.local",
          password: "long-enough-pw",
        })
      ).status,
    ).toBe(200);
  });
});
