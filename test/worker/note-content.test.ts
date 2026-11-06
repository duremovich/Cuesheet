// A note's content as a many-to-many link (`notes.content` ↔ `note_content`, like
// `notes.cues`): migration 0009 from the old single `notes.content_id`, link/unlink ops,
// cascades, history, roles, the agent /mutate API, share filtering, and old clients that
// still send `content_id`.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Role } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { Op, SnapshotResponse } from "../../src/shared/ops";
import { shareScope } from "../../src/shared/share";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { filterSnapshot } from "../../src/worker/share-filter";
import { api, createShow, loginAdmin, post, rewindMigrations } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `note-content-${Date.now()}-${seq++}`;
  const stub = env.SHOW.get(env.SHOW.idFromName(name));
  await stub.sync(name, name);
  return stub;
}

const ctx = (role: Role = "editor", userId = "u-editor"): MutationContext => ({
  userId,
  role,
  clientId: `client-${userId}`,
});

async function snapshot(stub: { snapshotJson(): Promise<string> }): Promise<SnapshotResponse> {
  return JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
}

function ok(r: MutateResult) {
  if (!r.ok) throw new Error(`mutate failed: ${r.error} (op ${r.opIndex})`);
  return r;
}

const content = (id: string, name: string): Op => ({
  op: "create",
  table: "content",
  id,
  fields: { name },
});
const note = (id: string, fields: Record<string, unknown> = {}): Op => ({
  op: "create",
  table: "notes",
  id,
  fields: { body: "fix", ...fields },
});
const link = (id: string, targetId: string, position?: number): Op => ({
  op: "link",
  table: "notes",
  id,
  field: "content",
  targetId,
  ...(position !== undefined ? { position } : {}),
});
const unlink = (id: string, targetId: string): Op => ({
  op: "unlink",
  table: "notes",
  id,
  field: "content",
  targetId,
});

describe("notes.content: migration 0009", () => {
  it("moves every note's content_id into note_content, clears the column, bumps nothing", async () => {
    const stub = await freshShow();
    const [k1, k2, n1, n2, n3] = [newId(), newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        content(k1, "101-001-A"),
        content(k2, "101-002-B"),
        note(n1),
        note(n2),
        note(n3),
      ]),
    );
    // Back to a show from before 0009: notes carried one content_id each.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      rewindMigrations(sql, "0009_note_content");
      sql.exec("UPDATE notes SET content_id = ? WHERE id = ?", k1, n1);
      sql.exec("UPDATE notes SET content_id = ? WHERE id = ?", k2, n2);
    });
    const before = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT max(version) AS v FROM changes").one(),
    );
    await evictDurableObject(stub);
    const snap = await snapshot(stub);
    expect(snap.joins.noteContent).toEqual({ [n1]: [k1], [n2]: [k2] });
    // The retired column is never on the wire, and it's cleared in storage.
    for (const n of snap.tables.notes) expect(n).not.toHaveProperty("content_id");
    const left = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM notes WHERE content_id IS NOT NULL")
        .one(),
    );
    expect(left.n).toBe(0);
    const after = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT max(version) AS v FROM changes").one(),
    );
    expect(after).toEqual(before);
    // The migrated link is an ordinary link: a second content goes after it.
    ok(await stub.mutate(ctx(), [link(n1, k2)]));
    expect((await snapshot(stub)).joins.noteContent[n1]).toEqual([k1, k2]);
  });
});

describe("notes.content: link ops", () => {
  it("links and unlinks several content items with stable positions, logged in history", async () => {
    const stub = await freshShow();
    const [k1, k2, k3, n] = [newId(), newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [content(k1, "A"), content(k2, "B"), content(k3, "C"), note(n)]));
    const r = ok(await stub.mutate(ctx(), [link(n, k1), link(n, k2), link(n, k3, 0)]));
    expect(r.ops).toEqual([
      { op: "link", table: "notes", id: n, field: "content", targetId: k1, position: 0 },
      { op: "link", table: "notes", id: n, field: "content", targetId: k2, position: 1 },
      { op: "link", table: "notes", id: n, field: "content", targetId: k3, position: 0 },
    ]);
    expect((await snapshot(stub)).joins.noteContent[n]).toEqual([k3, k1, k2]);
    // Linking again is a no-op; unlinking closes the gap.
    expect(ok(await stub.mutate(ctx(), [link(n, k1)])).ops).toEqual([]);
    ok(await stub.mutate(ctx(), [unlink(n, k1)]));
    expect((await snapshot(stub)).joins.noteContent[n]).toEqual([k3, k2]);

    const hist = await stub.history({ table: "notes", id: n });
    expect(hist.slice(0, 4).map((h) => [h.field, h.old, h.new])).toEqual([
      ["content", JSON.stringify(k1), null],
      ["content", null, JSON.stringify(k3)],
      ["content", null, JSON.stringify(k2)],
      ["content", null, JSON.stringify(k1)],
    ]);
  });

  it("deleting a content item unlinks it from its notes; deleting a note drops its links", async () => {
    const stub = await freshShow();
    const [k1, k2, n1, n2] = [newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        content(k1, "A"),
        content(k2, "B"),
        note(n1),
        note(n2),
        link(n1, k1),
        link(n1, k2),
        link(n2, k1),
      ]),
    );
    const del = ok(await stub.mutate(ctx(), [{ op: "delete", table: "content", id: k1 }]));
    expect(del.ops.filter((o) => o.op === "unlink")).toEqual([
      expect.objectContaining({ table: "notes", id: n1, field: "content", targetId: k1 }),
      expect.objectContaining({ table: "notes", id: n2, field: "content", targetId: k1 }),
    ]);
    let snap = await snapshot(stub);
    expect(snap.joins.noteContent).toEqual({ [n1]: [k2] });
    expect(snap.tables.notes).toHaveLength(2);

    const delNote = ok(await stub.mutate(ctx(), [{ op: "delete", table: "notes", id: n1 }]));
    expect(delNote.ops).toEqual([
      { op: "unlink", table: "notes", id: n1, field: "content", targetId: k2 },
      { op: "delete", table: "notes", id: n1 },
    ]);
    snap = await snapshot(stub);
    expect(snap.joins.noteContent).toEqual({});
    expect(snap.tables.content.map((c) => c.id)).toEqual([k2]);
  });

  it("rejects unknown targets and the wrong table", async () => {
    const stub = await freshShow();
    const [k, n, c] = [newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [content(k, "A"), note(n)]));
    expect(await stub.mutate(ctx(), [link(n, newId())])).toMatchObject({
      ok: false,
      status: 400,
      opIndex: 0,
    });
    // A cue id isn't content.
    ok(await stub.mutate(ctx(), [{ op: "create", table: "cues", id: c, fields: {} }]));
    expect(await stub.mutate(ctx(), [link(n, c)])).toMatchObject({ ok: false, status: 400 });
  });

  it("commenters link content to their own notes only; viewers not at all", async () => {
    const stub = await freshShow();
    const [k, theirs, mine] = [newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [content(k, "A"), note(theirs)]));
    const com = ctx("commenter", "u-commenter");
    expect(await stub.mutate(com, [link(theirs, k)])).toMatchObject({ ok: false, status: 403 });
    ok(await stub.mutate(com, [note(mine), link(mine, k)]));
    ok(await stub.mutate(com, [unlink(mine, k), link(mine, k)]));
    expect(await stub.mutate(ctx("viewer", "u-viewer"), [unlink(mine, k)])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect((await snapshot(stub)).joins.noteContent).toEqual({ [mine]: [k] });
  });
});

describe("notes.content: clients from before 0009", () => {
  it("a note create carrying content_id becomes the note plus a content link", async () => {
    const stub = await freshShow();
    const [k, n1, n2] = [newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [content(k, "A")]));
    // An old tab's noteCreateOps: content_id set (a cue with exactly one content) or null.
    const com = ctx("commenter", "u-commenter");
    const r = ok(
      await stub.mutate(com, [note(n1, { content_id: k }), note(n2, { content_id: null })]),
    );
    expect(r.ops.map((o) => o.op)).toEqual(["create", "link", "create"]);
    expect(r.ops[0]).toMatchObject({ op: "create", table: "notes", id: n1 });
    expect(r.ops[0] && "fields" in r.ops[0] ? r.ops[0].fields : {}).not.toHaveProperty(
      "content_id",
    );
    expect(r.ops[1]).toEqual({
      op: "link",
      table: "notes",
      id: n1,
      field: "content",
      targetId: k,
      position: 0,
    });
    const snap = await snapshot(stub);
    expect(snap.joins.noteContent).toEqual({ [n1]: [k] });
    expect(snap.tables.notes.map((n) => n.created_by)).toEqual(["u-commenter", "u-commenter"]);
    // A content id that doesn't exist fails the batch, as the old ref did.
    expect(await stub.mutate(ctx(), [note(newId(), { content_id: newId() })])).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await stub.mutate(ctx(), [note(newId(), { content_id: 5 })])).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("an update of content_id is refused with a reload hint, and changes nothing", async () => {
    const stub = await freshShow();
    const [k1, k2, n] = [newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [content(k1, "A"), content(k2, "B"), note(n), link(n, k1)]));
    const r = await stub.mutate(ctx(), [
      { op: "update", table: "notes", id: n, fields: { content_id: k2 } },
    ]);
    expect(r).toMatchObject({ ok: false, status: 400, opIndex: 0 });
    expect(r.ok ? "" : r.error).toMatch(/replaced by the notes\.content link; reload/);
    // Other tables have no retired columns: the usual message.
    const other = await stub.mutate(ctx(), [
      { op: "update", table: "content", id: k1, fields: { content_id: k2 } },
    ]);
    expect(other.ok ? "" : other.error).toBe("unknown field content.content_id");
    expect((await snapshot(stub)).joins.noteContent).toEqual({ [n]: [k1] });
  });
});

describe("notes.content: API and share links", () => {
  it("POST /mutate links and unlinks with the same op shape as other links", async () => {
    const cookie = await loginAdmin();
    const show = await createShow(cookie, "Note content API");
    const [k1, k2, n] = [newId(), newId(), newId()];
    const mutate = (ops: Op[]) =>
      post(`/api/shows/${show.id}/mutate`, { clientId: "agent", ops }, cookie);
    let res = await mutate([content(k1, "A"), content(k2, "B"), note(n), link(n, k1), link(n, k2)]);
    expect(res.status).toBe(200);
    res = await mutate([unlink(n, k1)]);
    expect(res.status).toBe(200);
    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    expect(snap.joins.noteContent).toEqual({ [n]: [k2] });
    res = await mutate([{ op: "update", table: "notes", id: n, fields: { content_id: k1 } }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/notes\.content link/);
  });

  it("notes presets see the content links of the notes they show, nothing else", async () => {
    const stub = await freshShow();
    const [k, p, n1, n2] = [newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        content(k, "A"),
        { op: "create", table: "persons", id: p, fields: { name: "Casey" } },
        note(n1),
        note(n2),
        link(n1, k),
        link(n2, k),
        { op: "link", table: "notes", id: n1, field: "assignees", targetId: p },
      ]),
    );
    const snap = await snapshot(stub);
    const base = { id: "l", showId: "s", table: "notes", viewId: null };
    const byPerson = filterSnapshot(
      snap,
      shareScope({ ...base, preset: "by-person", options: { person: p } }),
    );
    expect(byPerson.joins.noteContent).toEqual({ [n1]: [k] });
    // A cues view link has no notes in scope: no note links at all.
    const cues = filterSnapshot(snap, shareScope({ ...base, table: "cues", preset: null }));
    expect(cues.joins.noteContent).toEqual({});
  });
});
