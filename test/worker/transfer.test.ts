// Moving a show between instances (routes/transfer.ts, do/transfer.ts). One test
// instance plays both sides: a seeded show A is copied, the way scripts/migrate-show.ts
// does it, into a new id B (the show id remapped like a user id), then B must match A
// table by table, file by file, and through the app's own snapshot.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UploadUrlResponse } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { AnyOp } from "../../src/shared/ops";
import {
  canonicalJson,
  chunkRows,
  mapMemberships,
  R2_METADATA_HEADER,
  remapIds,
  SHA256_HEADER,
  type TransferFile,
  type TransferManifest,
  type TransferRow,
} from "../../src/shared/show-transfer";
import { api, createShow, loginAdmin, newUser, post } from "./helpers";

type Json = Record<string, unknown>;

async function json<T = Json>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text}`);
  return JSON.parse(text) as T;
}

const base = (id: string) => `/api/admin/shows/${id}/transfer`;

async function manifest(id: string, cookie: string) {
  return json<TransferManifest>(api(base(id), { cookie }));
}

async function allRows(id: string, table: string, cookie: string): Promise<TransferRow[]> {
  const out: TransferRow[] = [];
  let after = 0;
  for (;;) {
    const page = await json<{ rows: TransferRow[]; next: number | null }>(
      api(`${base(id)}/rows?table=${table}&after=${after}`, { cookie }),
    );
    out.push(...page.rows);
    if (page.next === null) return out;
    after = page.next;
  }
}

async function dumpTables(id: string, cookie: string) {
  const m = await manifest(id, cookie);
  const tables: Record<string, TransferRow[]> = {};
  for (const t of m.do.tables) tables[t.name] = await allRows(id, t.name, cookie);
  return { m, tables };
}

async function files(id: string, cookie: string) {
  return (await json<{ files: TransferFile[] }>(api(`${base(id)}/files`, { cookie }))).files;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function mutate(showId: string, cookie: string, ops: AnyOp[]) {
  return json(post(`/api/shows/${showId}/mutate`, { ops }, cookie));
}

async function upload(showId: string, cookie: string, noteId: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const reserved = await json<UploadUrlResponse>(
    post(
      `/api/shows/${showId}/attachments/upload-url`,
      {
        table: "notes",
        recordId: noteId,
        filename: "notes.txt",
        contentType: "text/plain",
        size: bytes.length,
      },
      cookie,
    ),
  );
  await json(
    api(reserved.uploadUrl, {
      method: "PUT",
      cookie,
      headers: { "Content-Type": reserved.contentType },
      body: bytes,
    }),
  );
  return reserved.attachmentId;
}

/** A show with a bit of everything: rows, links, history, a personal view, files, a deleted file. */
async function seed(admin: string) {
  const show = await createShow(admin, "Transfer Source");
  const member = await newUser(admin, "Member");
  await json(post(`/api/shows/${show.id}/members`, { email: member.email, role: "editor" }, admin));
  const id = { s: newId(), c1: newId(), c2: newId(), n1: newId(), n2: newId(), v: newId() };
  await mutate(show.id, admin, [
    { op: "create", table: "scenes", id: id.s, fields: { number: "101", name: "Open" } },
    { op: "create", table: "cues", id: id.c1, fields: { number: "1", scene_id: id.s } },
    { op: "create", table: "cues", id: id.c2, fields: { number: "2", scene_id: id.s } },
    { op: "create", table: "notes", id: id.n1, fields: { body: "fix rain", scene_id: id.s } },
  ] as AnyOp[]);
  // The member's own note, an edit, a personal view: their id must follow them.
  await mutate(show.id, member.cookie, [
    { op: "create", table: "notes", id: id.n2, fields: { body: "louder" } },
    { op: "link", table: "notes", id: id.n2, field: "cues", targetId: id.c1 },
    { op: "update", table: "cues", id: id.c2, fields: { description: "rain" } },
    {
      op: "create",
      table: "views",
      id: id.v,
      fields: { table: "cues", name: "Mine", owner_user_id: member.id },
    },
  ] as AnyOp[]);
  await upload(show.id, admin, id.n1, "keep me");
  const gone = await upload(show.id, admin, id.n1, "delete me");
  await mutate(show.id, admin, [{ op: "delete", table: "attachments", id: gone }] as AnyOp[]);
  await mutate(show.id, admin, [{ op: "delete", table: "cues", id: id.c2 }] as AnyOp[]);
  await json(post(`/api/shows/${show.id}/share-links`, { kind: "view", table: "cues" }, admin));
  return { show, member, id };
}

/** Copy show `from` into `to` as the CLI does, with user ids remapped by `users`. */
async function copyShow(
  from: string,
  to: string,
  cookie: string,
  users: Map<string, string>,
  opts: { overwrite?: boolean } = {},
) {
  const src = await dumpTables(from, cookie);
  // Both "instances" share one D1 here: share links need ids and token hashes of their own.
  const links = src.m.d1.shareLinks.flatMap((l) => [
    [String(l.id), newId()] as const,
    [String(l.token_hash), crypto.randomUUID().replace(/-/g, "").repeat(2)] as const,
  ]);
  const ids = new Map<string, string>([[from, to], ...users, ...links]);
  const begin = await post(
    `${base(to)}/begin`,
    { migrations: src.m.do.migrations, overwrite: opts.overwrite ?? false },
    cookie,
  );
  if (begin.status !== 200) return begin;
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(src.tables)) {
    counts[table] = rows.length;
    const mapped = JSON.parse(remapIds(JSON.stringify(rows), ids)) as TransferRow[];
    for (const chunk of chunkRows(mapped, 64 * 1024)) {
      await json(post(`${base(to)}/rows`, { table, rows: chunk }, cookie));
    }
  }
  for (const f of await files(from, cookie)) {
    const bytes = await (
      await api(`${base(from)}/file?key=${encodeURIComponent(f.key)}`, { cookie })
    ).arrayBuffer();
    await json(
      api(`${base(to)}/file?key=${encodeURIComponent(remapIds(f.key, ids))}`, {
        method: "PUT",
        cookie,
        body: bytes,
        headers: {
          [SHA256_HEADER]: await sha256(bytes),
          [R2_METADATA_HEADER]: JSON.stringify({
            httpMetadata: f.httpMetadata,
            customMetadata: f.customMetadata,
          }),
        },
      }),
    );
  }
  const d1 = JSON.parse(remapIds(JSON.stringify(src.m.d1), ids)) as TransferManifest["d1"];
  return post(
    `${base(to)}/finish`,
    {
      counts,
      sequences: src.m.do.sequences,
      show: d1.show,
      memberships: mapMemberships(d1.memberships, new Map()),
      shareLinks: d1.shareLinks,
    },
    cookie,
  );
}

// Several full copies per test: give them room on a loaded machine (the suite runs in parallel).
describe("show transfer", { timeout: 30_000 }, () => {
  it("is instance-admin only", async () => {
    const admin = await loginAdmin();
    const { show, member } = await seed(admin);
    expect((await api(base(show.id), { cookie: member.cookie })).status).toBe(403);
    expect((await api("/api/admin/users", { cookie: member.cookie })).status).toBe(403);
    expect((await api(base(show.id))).status).toBe(401);
    const begin = await post(`${base(newId())}/begin`, { migrations: [] }, member.cookie);
    expect(begin.status).toBe(403);
  });

  it("copies every table, the D1 rows and the files; remapped ids follow", async () => {
    const admin = await loginAdmin();
    const { show, member, id } = await seed(admin);
    const adminId = (await json<{ user: { id: string } }>(api("/api/me", { cookie: admin }))).user
      .id;
    const to = crypto.randomUUID();
    // The member has no account "on the target": their rows become the admin's.
    const users = new Map([[member.id, adminId]]);
    const res = await copyShow(show.id, to, admin, users);
    expect(res.status, await res.clone().text()).toBe(200);

    const ids = new Map([[show.id, to], ...users]);
    const src = await dumpTables(show.id, admin);
    const dst = await dumpTables(to, admin);
    expect(Object.keys(dst.tables).sort()).toEqual(Object.keys(src.tables).sort());
    for (const [table, rows] of Object.entries(src.tables)) {
      expect(canonicalJson(dst.tables[table]), table).toBe(
        canonicalJson(JSON.parse(remapIds(JSON.stringify(rows), ids))),
      );
    }
    // History, deleted-file bookkeeping and counters came along.
    expect(src.tables.changes?.length).toBeGreaterThan(5);
    expect(dst.tables.pending_r2_deletes).toHaveLength(1);
    expect(dst.m.do.version).toBe(src.m.do.version);
    expect(dst.m.do.sequences).toEqual(src.m.do.sequences);
    expect(dst.m.do.transfer).toMatchObject({ state: "imported", version: src.m.do.version });
    // The deleted file's purge is scheduled on the target too.
    expect(dst.m.do.alarm).not.toBeNull();

    // D1: same show row, the member merged into the admin (owner wins).
    expect(dst.m.d1.show).toEqual({ ...src.m.d1.show, id: to });
    expect(dst.m.d1.memberships).toEqual([
      expect.objectContaining({ show_id: to, user_id: adminId, role: "owner" }),
    ]);

    // Files: same keys under the new id, same bytes.
    const srcFiles = await files(show.id, admin);
    const dstFiles = await files(to, admin);
    expect(srcFiles.length).toBe(2); // the kept file and the deleted one (purged a day later)
    expect(dstFiles.map((f) => f.key)).toEqual(srcFiles.map((f) => remapIds(f.key, ids)));
    for (const f of srcFiles) {
      const a = await json<{ sha256: string }>(
        api(`${base(show.id)}/file-hash?key=${encodeURIComponent(f.key)}`, { cookie: admin }),
      );
      const b = await json<{ sha256: string }>(
        api(`${base(to)}/file-hash?key=${encodeURIComponent(remapIds(f.key, ids))}`, {
          cookie: admin,
        }),
      );
      expect(b.sha256).toBe(a.sha256);
    }

    // Through the app: the admin sees the show, its snapshot and history, and the file.
    const shows = await json<{ shows: { id: string }[] }>(api("/api/shows", { cookie: admin }));
    expect(shows.shows.map((s) => s.id)).toContain(to);
    const snapA = await (await api(`/api/shows/${show.id}/snapshot`, { cookie: admin })).text();
    const snapB = await (await api(`/api/shows/${to}/snapshot`, { cookie: admin })).text();
    const strip = (s: string) => {
      const o = JSON.parse(s) as { tables: { views: { owner_user_id: string | null }[] } };
      // A's snapshot (as the admin) can't show the member's personal view; B's can.
      o.tables.views = o.tables.views.filter((v) => v.owner_user_id === null);
      return canonicalJson(o);
    };
    expect(strip(snapB)).toBe(strip(remapIds(snapA, ids)));
    const viewsB = JSON.parse(snapB).tables.views as { id: string; owner_user_id: string }[];
    expect(viewsB.find((v) => v.id === id.v)?.owner_user_id).toBe(adminId);
    const file = JSON.parse(snapB).tables.attachments[0] as { id: string };
    const dl = await api(`/api/shows/${to}/attachments/${file.id}`, { cookie: admin });
    expect(await dl.text()).toBe("keep me");
    const hist = await api(`/api/shows/${to}/history?table=cues&id=${id.c2}`, { cookie: admin });
    expect(((await hist.json()) as { changes: unknown[] }).changes.length).toBeGreaterThan(1);

    // The target still works: an edit lands on top of the copied version.
    const r = await json<{ version: number }>(
      post(
        `/api/shows/${to}/mutate`,
        { ops: [{ op: "update", table: "cues", id: id.c1, fields: { description: "x" } }] },
        admin,
      ),
    );
    expect(r.version).toBe(src.m.do.version + 1);
  });

  it("refuses existing shows; overwrite only for an unedited previous import", async () => {
    const admin = await loginAdmin();
    const { show, member } = await seed(admin);
    const other = await createShow(admin, "Existing");
    // A show that exists (D1 row, no import marker): never, overwrite or not.
    for (const overwrite of [false, true]) {
      const res = await copyShow(show.id, other.id, admin, new Map(), { overwrite });
      expect(res.status).toBe(409);
    }
    const to = crypto.randomUUID();
    const users = new Map([[member.id, member.id]]);
    expect((await copyShow(show.id, to, admin, users)).status).toBe(200);
    // Again: refused without overwrite, fine with it (nothing changed since).
    expect((await copyShow(show.id, to, admin, users)).status).toBe(409);
    expect((await copyShow(show.id, to, admin, users, { overwrite: true })).status).toBe(200);
    // Once someone edits the imported show, overwrite is refused too.
    await mutate(to, admin, [
      { op: "create", table: "scenes", id: newId(), fields: { number: "9" } },
    ] as AnyOp[]);
    expect((await copyShow(show.id, to, admin, users, { overwrite: true })).status).toBe(409);
  });

  it("an interrupted import leaves no show behind and can be redone", async () => {
    const admin = await loginAdmin();
    const { show } = await seed(admin);
    const to = crypto.randomUUID();
    const src = await manifest(show.id, admin);
    await json(post(`${base(to)}/begin`, { migrations: src.do.migrations }, admin));
    await json(
      post(
        `${base(to)}/rows`,
        { table: "scenes", rows: await allRows(show.id, "scenes", admin) },
        admin,
      ),
    );
    // Wrong counts: refused, nothing applied, still importing.
    const bad = await post(
      `${base(to)}/finish`,
      {
        counts: { scenes: 99 },
        sequences: {},
        show: { ...src.d1.show, id: to },
        memberships: [],
        shareLinks: [],
      },
      admin,
    );
    expect(bad.status).toBe(400);
    const mid = await manifest(to, admin);
    expect(mid.d1.show).toBeNull();
    expect(mid.do.transfer?.state).toBe("importing");
    expect(mid.do.tables.find((t) => t.name === "scenes")?.rows).toBe(0);
    // Resume = start over with overwrite.
    const res = await copyShow(show.id, to, admin, new Map(), { overwrite: true });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("checks schema, keys, columns and checksums", async () => {
    const admin = await loginAdmin();
    const { show } = await seed(admin);
    const to = crypto.randomUUID();
    const src = await manifest(show.id, admin);
    const mismatch = await post(`${base(to)}/begin`, { migrations: ["nope"] }, admin);
    expect(mismatch.status).toBe(409);
    // Rows before begin.
    expect((await post(`${base(to)}/rows`, { table: "scenes", rows: [] }, admin)).status).toBe(409);
    await json(post(`${base(to)}/begin`, { migrations: src.do.migrations }, admin));
    const badCol = await post(
      `${base(to)}/rows`,
      { table: "scenes", rows: [{ __rowid: 1, id: "x", nope: 1 }] },
      admin,
    );
    expect(badCol.status).toBe(400);
    const badTable = await post(`${base(to)}/rows`, { table: "sqlite_master", rows: [] }, admin);
    expect(badTable.status).toBe(400);
    const put = (key: string, sha: string) =>
      api(`${base(to)}/file?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        cookie: admin,
        body: "abc",
        headers: { [SHA256_HEADER]: sha },
      });
    const abc = await sha256(new TextEncoder().encode("abc").buffer as ArrayBuffer);
    expect((await put(`shows/${show.id}/x/y`, abc)).status).toBe(400); // another show's key
    expect((await put(`shows/${to}/x/y`, "0".repeat(64))).status).toBe(400);
    expect(await env.FILES.head(`shows/${to}/x/y`)).toBeNull();
    expect((await put(`shows/${to}/x/y`, abc)).status).toBe(200);
  });

  it("reads raw rows with their rowids", async () => {
    const admin = await loginAdmin();
    const { show } = await seed(admin);
    const rows = await allRows(show.id, "changes", admin);
    expect(rows.every((r) => r.__rowid === r.version)).toBe(true);
    const stub = env.SHOW.get(env.SHOW.idFromName(show.id));
    const n = await runInDurableObject(
      stub,
      (_o, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM changes").one().n,
    );
    expect(rows).toHaveLength(n);
  });
});
