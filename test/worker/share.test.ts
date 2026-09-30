// Read-only share links (R23): owner CRUD, resolving a link (cookie scoped to the show),
// what a share viewer may read (snapshot filtered to the link's table, attachments only for
// that table's rows, script text only for a calling-script link), refusals (mutate 403,
// other routes 401, other shows), live ops filtered on its socket, revoke → 410 + sockets
// closed, expiry, and rate limiting of bad tokens.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UploadUrlResponse } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { Op, SnapshotResponse } from "../../src/shared/ops";
import type {
  CreateShareLinkResponse,
  ShareInfoResponse,
  ShareLinksResponse,
} from "../../src/shared/share";
import { api, collect, createShow, isType, loginAdmin, newUser, post, WS_HEADERS } from "./helpers";

function mutate(showId: string, cookie: string, ops: Op[]) {
  return post(`/api/shows/${showId}/mutate`, { clientId: "t", ops }, cookie);
}

async function upload(
  showId: string,
  cookie: string,
  target: { table: string; recordId: string },
  name: string,
) {
  const bytes = new TextEncoder().encode(`hello ${name}`);
  const r = await post(
    `/api/shows/${showId}/attachments/upload-url`,
    { ...target, filename: name, contentType: "text/plain", size: bytes.length },
    cookie,
  );
  expect(r.status).toBe(200);
  const reserved = (await r.json()) as UploadUrlResponse;
  const put = await api(reserved.uploadUrl, {
    method: "PUT",
    cookie,
    headers: { "Content-Type": reserved.contentType },
    body: bytes,
  });
  expect(put.status).toBe(201);
  return reserved.attachmentId;
}

/** A show with a scene, a cue, content (with a file), a note (with a file). */
async function setup() {
  const admin = await loginAdmin();
  const show = await createShow(admin, "Shared show");
  const ids = { scene: newId(), cue: newId(), content: newId(), note: newId() };
  const res = await mutate(show.id, admin, [
    { op: "create", table: "scenes", id: ids.scene, fields: { number: "101", name: "Top" } },
    {
      op: "create",
      table: "cues",
      id: ids.cue,
      fields: { number: "1", description: "Preshow", scene_id: ids.scene },
    },
    { op: "create", table: "content", id: ids.content, fields: { name: "101-001-LOGO" } },
    { op: "create", table: "notes", id: ids.note, fields: { body: "Secret note" } },
  ]);
  expect(res.status).toBe(200);
  const contentFile = await upload(
    show.id,
    admin,
    { table: "content", recordId: ids.content },
    "c.txt",
  );
  const noteFile = await upload(show.id, admin, { table: "notes", recordId: ids.note }, "n.txt");
  return { admin, showId: show.id, ids, contentFile, noteFile };
}

async function createLink(showId: string, cookie: string, body: Record<string, unknown>) {
  const res = await post(`/api/shows/${showId}/share-links`, body, cookie);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as CreateShareLinkResponse;
}

/** Resolve a link like the /s/<token> page does; returns the viewer's cookie. */
async function openLink(path: string, headers: Record<string, string> = {}) {
  const token = path.split("/").at(-1) as string;
  const res = await api(`/api/share/${token}`, { headers });
  return { res, token, cookie: `cs_share=${token}` };
}

describe("share links", () => {
  it("only the owner creates, lists and revokes links; bad requests are refused", async () => {
    const { admin, showId } = await setup();
    const editor = await newUser(admin, "Editor");
    await post(`/api/shows/${showId}/members`, { email: editor.email, role: "editor" }, admin);
    const body = { kind: "view", table: "cues" };
    expect((await post(`/api/shows/${showId}/share-links`, body, editor.cookie)).status).toBe(403);
    expect((await api(`/api/shows/${showId}/share-links`, { cookie: editor.cookie })).status).toBe(
      403,
    );
    const bad = [
      { kind: "nope", table: "cues" },
      { kind: "view", table: "users" },
      { kind: "view", table: "cues", preset: "by-person" },
      { kind: "print", table: "notes", preset: "nope" },
      { kind: "view", table: "cues", viewId: newId() },
      { kind: "view", table: "cues", expiresAt: Date.now() - 1000 },
    ];
    for (const b of bad) {
      expect(
        (await post(`/api/shows/${showId}/share-links`, b, admin)).status,
        JSON.stringify(b),
      ).toBe(400);
    }
    const { link, path } = await createLink(showId, admin, { ...body, label: "For the SM" });
    expect(path).toMatch(/^\/s\/[A-Za-z0-9_-]{40,}$/);
    // A view link without a view shows the table's shared default.
    expect(link.viewId).toBeTruthy();
    expect(link).toMatchObject({ kind: "view", table: "cues", label: "For the SM", preset: null });
    const list = (await (
      await api(`/api/shows/${showId}/share-links`, { cookie: admin })
    ).json()) as ShareLinksResponse;
    expect(list.links.map((l) => l.id)).toEqual([link.id]);
    // Only a hash of the token is stored.
    const row = await env.DB.prepare("SELECT token_hash FROM share_links WHERE id = ?")
      .bind(link.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(path).not.toContain(row?.token_hash ?? "x");
  });

  it("resolves a link: show + target, a cookie scoped to the show's API, noindex", async () => {
    const { admin, showId } = await setup();
    const { link, path } = await createLink(showId, admin, { kind: "view", table: "cues" });
    const { res } = await openLink(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^cs_share=[A-Za-z0-9_-]+; /);
    expect(cookie).toContain(`Path=/api/shows/${showId}`);
    expect(cookie).toContain("HttpOnly");
    const info = (await res.json()) as ShareInfoResponse;
    expect(info).toEqual({
      link: {
        id: link.id,
        kind: "view",
        table: "cues",
        viewId: link.viewId,
        preset: null,
        options: {},
        label: null,
      },
      show: { id: showId, name: "Shared show", currentSession: null },
    });
    expect((await api("/api/share/not-a-real-token-at-all-000000")).status).toBe(404);
  });

  it("a share viewer reads only its table's data and files, and nothing else", async () => {
    const { admin, showId, ids, contentFile, noteFile } = await setup();
    const { link, path } = await createLink(showId, admin, { kind: "view", table: "content" });
    const { cookie } = await openLink(path);

    const info = await api(`/api/shows/${showId}`, { cookie });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ role: "viewer" });

    const snap = (await (
      await api(`/api/shows/${showId}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    expect(snap.tables.content.map((c) => c.id)).toEqual([ids.content]);
    expect(snap.tables.scenes.map((s) => s.id)).toEqual([ids.scene]); // labels
    expect(snap.tables.notes).toEqual([]);
    expect(snap.tables.views.map((v) => v.id)).toEqual([link.viewId]);
    expect(snap.tables.attachments.map((a) => a.id)).toEqual([contentFile]);
    expect(snap.joins.noteCues).toEqual({});
    expect(Object.keys(snap.fieldOptions).some((k) => k.startsWith("notes."))).toBe(false);

    // Files: the table's rows only (others look missing).
    expect((await api(`/api/shows/${showId}/attachments/${contentFile}`, { cookie })).status).toBe(
      200,
    );
    expect((await api(`/api/shows/${showId}/attachments/${noteFile}`, { cookie })).status).toBe(
      404,
    );
    expect(
      (await api(`/api/shows/${showId}/attachments/${noteFile}/thumb`, { cookie })).status,
    ).toBe(404);

    // Writes are refused; other routes need a session.
    const write = await mutate(showId, cookie, [
      { op: "update", table: "content", id: ids.content, fields: { name: "x" } },
    ]);
    expect(write.status).toBe(403);
    expect((await api(`/api/shows/${showId}/history`, { cookie })).status).toBe(403);
    expect((await api(`/api/shows/${showId}/members`, { cookie })).status).toBe(403);
    expect((await api(`/api/shows/${showId}/export.json`, { cookie })).status).toBe(403);
    expect((await api("/api/shows", { cookie })).status).toBe(401);
    expect((await api("/api/me", { cookie })).status).toBe(200);
    expect(await (await api("/api/me", { cookie })).json()).toEqual({ user: null });
    // Script text is only for calling-script links.
    expect(
      (await api(`/api/shows/${showId}/script/versions/${newId()}/text`, { cookie })).status,
    ).toBe(404);

    // Another show: the cookie doesn't count there.
    const other = await createShow(admin, "Other show");
    expect((await api(`/api/shows/${other.id}/snapshot`, { cookie })).status).toBe(401);
  });

  it("a member's own session wins over a share cookie", async () => {
    const { admin, showId } = await setup();
    const { path } = await createLink(showId, admin, { kind: "view", table: "cues" });
    const { token } = await openLink(path);
    const both = `${admin}; cs_share=${token}`;
    const snap = (await (
      await api(`/api/shows/${showId}/snapshot`, { cookie: both })
    ).json()) as SnapshotResponse;
    expect(snap.tables.notes).toHaveLength(1);
    // A signed-in non-member with the link is a share viewer.
    const outsider = await newUser(admin, "Outsider");
    const theirs = (await (
      await api(`/api/shows/${showId}/snapshot`, {
        cookie: `${outsider.cookie}; cs_share=${token}`,
      })
    ).json()) as SnapshotResponse;
    expect(theirs.tables.cues).toHaveLength(1);
    expect(theirs.tables.notes).toEqual([]);
  });

  it("streams only in-scope ops live; revoking closes the sockets and the link answers 410", async () => {
    const { admin, showId, ids } = await setup();
    const { link, path } = await createLink(showId, admin, { kind: "view", table: "cues" });
    const { cookie, token } = await openLink(path);
    const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
    expect(res.status).toBe(101);
    const viewer = collect(res.webSocket as WebSocket);
    expect(await viewer.next(isType("hello"))).toMatchObject({ clients: 1, readOnly: 1 });

    expect(
      (
        await mutate(showId, admin, [
          { op: "update", table: "cues", id: ids.cue, fields: { description: "Live!" } },
        ])
      ).status,
    ).toBe(200);
    const cueOps = await viewer.next(isType("ops"));
    expect(cueOps.ops).toEqual([
      expect.objectContaining({ op: "update", table: "cues", id: ids.cue }),
    ]);

    // A note change reaches the viewer as an empty batch (versions stay gap-free).
    await mutate(showId, admin, [
      { op: "update", table: "notes", id: ids.note, fields: { body: "Still secret" } },
    ]);
    const noteOps = await viewer.next(isType("ops"));
    expect(noteOps.prevVersion).toBe(cueOps.version);
    expect(noteOps.ops).toEqual([]);

    const revoke = await api(`/api/shows/${showId}/share-links/${link.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect(revoke.status).toBe(200);
    await viewer.next(isType("revoked"));
    expect(await viewer.closedWith()).toBe(4003);
    expect((await api(`/api/share/${token}`)).status).toBe(410);
    expect((await api(`/api/shows/${showId}/snapshot`, { cookie })).status).toBe(401);
  });

  it("expired links answer 410", async () => {
    const { admin, showId } = await setup();
    const { link, path } = await createLink(showId, admin, {
      kind: "view",
      table: "cues",
      expiresAt: Date.now() + 60_000,
    });
    const { token, cookie } = await openLink(path);
    expect((await api(`/api/shows/${showId}/snapshot`, { cookie })).status).toBe(200);
    await env.DB.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, link.id)
      .run();
    expect((await api(`/api/share/${token}`)).status).toBe(410);
    expect((await api(`/api/shows/${showId}/snapshot`, { cookie })).status).toBe(401);
  });

  it("preset links: a calling-script link may read script text; notes by person sees notes", async () => {
    const { admin, showId } = await setup();
    const calling = await createLink(showId, admin, {
      kind: "print",
      table: "cues",
      preset: "calling-script",
    });
    const cs = await openLink(calling.path);
    const snap = (await (
      await api(`/api/shows/${showId}/snapshot`, { cookie: cs.cookie })
    ).json()) as SnapshotResponse;
    expect(snap.tables.cues).toHaveLength(1);
    expect(snap.tables.notes).toEqual([]);
    expect(snap.tables.views).toEqual([]);
    // Allowed through the guard (then 404: there's no such version).
    const text = await api(`/api/shows/${showId}/script/versions/${newId()}/text`, {
      cookie: cs.cookie,
    });
    expect(text.status).toBe(404);
    expect(await text.json()).not.toEqual({ error: "Not found" });

    const byPerson = await createLink(showId, admin, {
      kind: "print",
      table: "notes",
      preset: "by-person",
      options: { session: "Tech 2" },
    });
    expect(byPerson.link.options).toEqual({ session: "Tech 2" });
    const bp = await openLink(byPerson.path);
    const notes = (await (
      await api(`/api/shows/${showId}/snapshot`, { cookie: bp.cookie })
    ).json()) as SnapshotResponse;
    expect(notes.tables.notes).toHaveLength(1);
    expect(notes.tables.attachments).toEqual([]);
  });

  it("rate-limits bad tokens per IP (429 + Retry-After)", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.77" };
    for (let i = 0; i < 10; i++) {
      expect(
        (await api(`/api/share/bad-token-${i}-xxxxxxxxxxxxxxxxxxxx`, { headers: ip })).status,
      ).toBe(404);
    }
    const blocked = await api("/api/share/bad-token-x-xxxxxxxxxxxxxxxxxxxx", { headers: ip });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    const other = await api("/api/share/bad-token-y-xxxxxxxxxxxxxxxxxxxx", {
      headers: { "CF-Connecting-IP": "203.0.113.78" },
    });
    expect(other.status).toBe(404);
  });
});
