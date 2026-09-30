// The op engine inside the ShowDO: ordering, validation, cascades, links, roles, history,
// versions and broadcast.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Role } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { Op, SnapshotResponse } from "../../src/shared/ops";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { connectDO, isType } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `ops-${Date.now()}-${seq++}`;
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

const cue = (id: string, fields: Record<string, unknown> = {}, placement = {}): Op => ({
  op: "create",
  table: "cues",
  id,
  fields,
  ...placement,
});

describe("ops: create and order", () => {
  it("computes order keys for end, start, middle (after and before)", async () => {
    const stub = await freshShow();
    const [a, b, c, d, e] = [newId(), newId(), newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [cue(a, { number: "1" }), cue(b, { number: "3" })]));
    ok(await stub.mutate(ctx(), [cue(c, { number: "0" }, { after: null })]));
    ok(await stub.mutate(ctx(), [cue(d, { number: "2" }, { after: a })]));
    ok(await stub.mutate(ctx(), [cue(e, { number: "2.5" }, { before: b })]));
    const snap = await snapshot(stub);
    expect(snap.tables.cues.map((r) => r.number)).toEqual(["0", "1", "2", "2.5", "3"]);
    const keys = snap.tables.cues.map((r) => r.order_key);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(5);
  });

  it("fills defaults, timestamps and creator, and returns resolved ops", async () => {
    const stub = await freshShow();
    const id = newId();
    const r = ok(await stub.mutate(ctx(), [cue(id, { number: "14.20", description: "Vamp" })]));
    expect(r.prevVersion).toBe(0);
    expect(r.version).toBe(1);
    const [op] = r.ops;
    expect(op).toMatchObject({
      op: "create",
      table: "cues",
      id,
      fields: {
        number: "14.20",
        description: "Vamp",
        is_section: false,
        scene_id: null,
        custom: {},
        created_by: "u-editor",
        updated_by: "u-editor",
      },
    });
    expect(op && "fields" in op && typeof op.fields.order_key).toBe("string");
  });

  it("moves a row by rewriting only its key", async () => {
    const stub = await freshShow();
    const ids = [newId(), newId(), newId()];
    ok(
      await stub.mutate(
        ctx(),
        ids.map((id, i) => cue(id, { number: String(i + 1) })),
      ),
    );
    const before = await snapshot(stub);
    const r = ok(
      await stub.mutate(ctx(), [{ op: "move", table: "cues", id: ids[2] as string, after: null }]),
    );
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({
      op: "move",
      id: ids[2],
      fields: { order_key: expect.any(String) },
    });
    const after = await snapshot(stub);
    expect(after.tables.cues.map((c) => c.number)).toEqual(["3", "1", "2"]);
    // The other rows kept their keys.
    expect(after.tables.cues.slice(1).map((c) => c.order_key)).toEqual(
      before.tables.cues.slice(0, 2).map((c) => c.order_key),
    );
    // Moving back to the end.
    ok(await stub.mutate(ctx(), [{ op: "move", table: "cues", id: ids[2] as string }]));
    expect((await snapshot(stub)).tables.cues.map((c) => c.number)).toEqual(["1", "2", "3"]);
    // Unknown neighbour → 400 with the op index.
    const bad = await stub.mutate(ctx(), [
      { op: "move", table: "cues", id: ids[0] as string, after: newId() },
    ]);
    expect(bad).toMatchObject({ ok: false, status: 400, opIndex: 0 });
  });
});

describe("ops: validation", () => {
  it("rejects unknown fields, bad types and non-options; rolls back the whole batch", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(ctx(), [cue(id, { number: "1" })]));
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ nope: 1 }, /unknown field cues.nope/],
      [{ number: 5 }, /cues.number must be text/],
      [{ is_section: "yes" }, /true or false/],
      [{ status: "Bogus" }, /"Bogus" is not an option/],
      [{ scene_id: newId() }, /scenes .* not found/],
      [{ created_by: "x" }, /unknown field/],
      [{ custom: [] }, /custom must be an object/],
    ];
    for (const [fields, msg] of cases) {
      const r = await stub.mutate(ctx(), [{ op: "update", table: "cues", id, fields }]);
      expect(r.ok, JSON.stringify(fields)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msg);
    }
    // A good op followed by a bad one: nothing is applied.
    const v = await stub.version();
    const r = await stub.mutate(ctx(), [
      { op: "update", table: "cues", id, fields: { description: "changed" } },
      { op: "update", table: "cues", id, fields: { status: "Nope" } },
    ]);
    expect(r).toMatchObject({ ok: false, status: 400, opIndex: 1 });
    expect(await stub.version()).toBe(v);
    expect((await snapshot(stub)).tables.cues[0]?.description).toBeNull();
    // Malformed ops.
    expect(await stub.mutate(ctx(), [{ op: "explode" }])).toMatchObject({ ok: false, opIndex: 0 });
    expect(await stub.mutate(ctx(), "nope")).toMatchObject({ ok: false });
    expect(await stub.mutate(ctx(), [cue(id)])).toMatchObject({
      ok: false,
      error: /already exists/,
    });
  });

  it("validates selects and multi-selects against the show's options; merges custom", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(
      await stub.mutate(ctx(), [
        {
          op: "create",
          table: "notes",
          id,
          fields: { body: "hi", type: ["Content", "Programming"], priority: "1", custom: { a: 1 } },
        },
      ]),
    );
    expect(
      await stub.mutate(ctx(), [
        { op: "update", table: "notes", id, fields: { type: ["Content", "Content"] } },
      ]),
    ).toMatchObject({ ok: false, error: /twice/ });
    expect(
      await stub.mutate(ctx(), [{ op: "update", table: "notes", id, fields: { priority: "9" } }]),
    ).toMatchObject({ ok: false });
    const r = ok(
      await stub.mutate(ctx(), [
        {
          op: "update",
          table: "notes",
          id,
          fields: { custom: { b: "x", a: null }, status: "Done" },
        },
      ]),
    );
    expect(r.ops[0]).toMatchObject({
      op: "update",
      fields: {
        custom: { b: "x" },
        status: "Done",
        completed_by: "u-editor",
        completed_at: expect.any(Number),
      },
    });
    const note = (await snapshot(stub)).tables.notes[0];
    expect(note).toMatchObject({
      type: ["Content", "Programming"],
      custom: { b: "x" },
      status: "Done",
    });
    // Leaving Done clears completion.
    const r2 = ok(
      await stub.mutate(ctx(), [{ op: "update", table: "notes", id, fields: { status: "Open" } }]),
    );
    expect(r2.ops[0]).toMatchObject({ fields: { completed_at: null, completed_by: null } });
    // Unchanged values produce no op and no new version.
    const v = await stub.version();
    const r3 = ok(
      await stub.mutate(ctx(), [{ op: "update", table: "notes", id, fields: { status: "Open" } }]),
    );
    expect(r3.ops).toEqual([]);
    expect(r3.version).toBe(v);
  });
});

describe("ops: links and deletes", () => {
  it("links and unlinks many-to-many fields with stable positions", async () => {
    const stub = await freshShow();
    const c1 = newId();
    const [p1, p2, p3] = [newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        cue(c1),
        ...[p1, p2, p3].map(
          (id, i): Op => ({ op: "create", table: "persons", id, fields: { name: `P${i}` } }),
        ),
        { op: "link", table: "cues", id: c1, field: "assignees", targetId: p1 },
        { op: "link", table: "cues", id: c1, field: "assignees", targetId: p2 },
        { op: "link", table: "cues", id: c1, field: "assignees", targetId: p3, position: 0 },
      ]),
    );
    let snap = await snapshot(stub);
    expect(snap.joins.cueAssignees[c1]).toEqual([p3, p1, p2]);
    // Linking twice is a no-op; unlinking closes the gap.
    const r = ok(
      await stub.mutate(ctx(), [
        { op: "link", table: "cues", id: c1, field: "assignees", targetId: p1 },
        { op: "unlink", table: "cues", id: c1, field: "assignees", targetId: p3 },
      ]),
    );
    expect(r.ops).toEqual([
      { op: "unlink", table: "cues", id: c1, field: "assignees", targetId: p3 },
    ]);
    snap = await snapshot(stub);
    expect(snap.joins.cueAssignees[c1]).toEqual([p1, p2]);
    expect(
      await stub.mutate(ctx(), [
        { op: "link", table: "cues", id: c1, field: "scene", targetId: p1 },
      ]),
    ).toMatchObject({ ok: false, error: /not a link field/ });
    expect(
      await stub.mutate(ctx(), [
        { op: "link", table: "cues", id: c1, field: "content", targetId: p1 },
      ]),
    ).toMatchObject({ ok: false, error: /content .* not found/ });
  });

  it("deleting a scene unassigns its cues and content; deleting a cue drops its links", async () => {
    const stub = await freshShow();
    const [s, c, k, n, p] = [newId(), newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "scenes", id: s, fields: { number: "101", name: "Speakeasy" } },
        { op: "create", table: "persons", id: p, fields: { name: "Casey" } },
        { op: "create", table: "content", id: k, fields: { name: "101-001", scene_id: s } },
        cue(c, { number: "1", scene_id: s }),
        { op: "create", table: "notes", id: n, fields: { body: "fix", scene_id: s } },
        { op: "link", table: "cues", id: c, field: "content", targetId: k },
        { op: "link", table: "cues", id: c, field: "assignees", targetId: p },
        { op: "link", table: "notes", id: n, field: "cues", targetId: c },
      ]),
    );
    const del = ok(await stub.mutate(ctx(), [{ op: "delete", table: "scenes", id: s }]));
    expect(del.ops.map((o) => `${o.op}:${o.table}`)).toEqual([
      "update:cues",
      "update:content",
      "update:notes",
      "delete:scenes",
    ]);
    let snap = await snapshot(stub);
    expect(snap.tables.scenes).toEqual([]);
    expect(snap.tables.cues[0]?.scene_id).toBeNull();
    expect(snap.tables.content[0]?.scene_id).toBeNull();

    const delCue = ok(await stub.mutate(ctx(), [{ op: "delete", table: "cues", id: c }]));
    expect(delCue.ops).toEqual([
      { op: "unlink", table: "cues", id: c, field: "content", targetId: k },
      { op: "unlink", table: "cues", id: c, field: "assignees", targetId: p },
      { op: "unlink", table: "notes", id: n, field: "cues", targetId: c },
      { op: "delete", table: "cues", id: c },
    ]);
    snap = await snapshot(stub);
    expect(snap.tables.cues).toEqual([]);
    expect(snap.tables.content).toHaveLength(1);
    expect(snap.tables.notes).toHaveLength(1);
    expect(snap.joins).toEqual({
      cueContent: {},
      cueAssignees: {},
      noteCues: {},
      noteAssignees: {},
    });

    // Deleting a person nulls content.creator_id.
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "content", id: k, fields: { creator_id: p } },
      ]),
    );
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "persons", id: p }]));
    expect((await snapshot(stub)).tables.content[0]?.creator_id).toBeNull();
  });
});

describe("ops: roles", () => {
  it("viewers can't change anything", async () => {
    const stub = await freshShow();
    const r = await stub.mutate(ctx("viewer"), [cue(newId())]);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("commenters may only create and change their own notes and those notes' links", async () => {
    const stub = await freshShow();
    const [c, theirs, mine, p] = [newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        cue(c),
        { op: "create", table: "persons", id: p, fields: { name: "P" } },
        { op: "create", table: "notes", id: theirs, fields: { body: "editor's" } },
      ]),
    );
    const com = ctx("commenter", "u-commenter");
    expect(await stub.mutate(com, [cue(newId())])).toMatchObject({ ok: false, status: 403 });
    expect(
      await stub.mutate(com, [{ op: "update", table: "cues", id: c, fields: { number: "9" } }]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await stub.mutate(com, [{ op: "update", table: "notes", id: theirs, fields: { body: "x" } }]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(await stub.mutate(com, [{ op: "delete", table: "notes", id: theirs }])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await stub.mutate(com, [
        { op: "link", table: "notes", id: theirs, field: "cues", targetId: c },
      ]),
    ).toMatchObject({ ok: false, status: 403 });
    ok(
      await stub.mutate(com, [
        { op: "create", table: "notes", id: mine, fields: { body: "mine" } },
        { op: "link", table: "notes", id: mine, field: "cues", targetId: c },
        { op: "link", table: "notes", id: mine, field: "assignees", targetId: p },
        { op: "update", table: "notes", id: mine, fields: { body: "mine, edited" } },
      ]),
    );
    ok(await stub.mutate(com, [{ op: "delete", table: "notes", id: mine }]));
  });
});

describe("ops: history, versions, broadcast", () => {
  it("writes one change row per field and one version per batch", async () => {
    const stub = await freshShow();
    const [a, b] = [newId(), newId()];
    const r1 = ok(await stub.mutate(ctx(), [cue(a, { number: "1" }), cue(b, { number: "2" })]));
    expect(r1).toMatchObject({ prevVersion: 0, version: 2 });
    const r2 = ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "cues", id: a, fields: { number: "1.5", description: "d" } },
        { op: "move", table: "cues", id: a, after: b },
      ]),
    );
    expect(r2).toMatchObject({ prevVersion: 2, version: 5 });
    const hist = await stub.history({ table: "cues", id: a });
    expect(hist.map((h) => h.field)).toEqual(["order_key", "description", "number", "*"]);
    expect(hist[2]).toMatchObject({
      userId: "u-editor",
      old: JSON.stringify("1"),
      new: JSON.stringify("1.5"),
      clientId: "client-u-editor",
    });
    expect(JSON.parse(hist[3]?.new ?? "null")).toMatchObject({ id: a, number: "1" });
    expect(await stub.history({ limit: 2 })).toHaveLength(2);
  });

  it("sends the version on connect and broadcasts resolved ops to every socket", async () => {
    const stub = await freshShow();
    ok(await stub.mutate(ctx(), [cue(newId())]));
    const a = await connectDO(stub, "alice");
    const b = await connectDO(stub, "bob");
    expect(await a.next(isType("version"))).toEqual({ type: "version", version: 1 });
    await b.next(isType("version"));
    const id = newId();
    const r = ok(await stub.mutate(ctx(), [cue(id, { number: "7" })]));
    for (const s of [a, b]) {
      const msg = await s.next(isType("ops"));
      expect(msg).toEqual({
        type: "ops",
        prevVersion: 1,
        version: 2,
        clientId: "client-u-editor",
        ops: r.ops,
      });
    }
    // A no-op batch isn't broadcast.
    ok(await stub.mutate(ctx(), [{ op: "update", table: "cues", id, fields: { number: "7" } }]));
    ok(await stub.mutate(ctx(), [{ op: "update", table: "cues", id, fields: { number: "8" } }]));
    expect(await a.next(isType("ops"))).toMatchObject({ prevVersion: 2, version: 3 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("disconnectUser closes only that user's sockets", async () => {
    const stub = await freshShow();
    const a = await connectDO(stub, "alice");
    const a2 = await connectDO(stub, "alice");
    const b = await connectDO(stub, "bob");
    expect(await b.next(isType("hello"))).toMatchObject({ clients: 3 });
    expect(await stub.disconnectUser("alice")).toBe(2);
    // Told why first, so the client stops reconnecting.
    expect(await a.next(isType("revoked"))).toEqual({ type: "revoked" });
    expect(await a.closedWith()).toBe(4003);
    expect(await a2.closedWith()).toBe(4003);
    expect(await b.next((m): m is never => m.type === "presence" && m.clients === 1)).toBeTruthy();
    b.ws.close(1000);
  });

  it("notifyRole tells only that user's sockets their new role, and keeps them open", async () => {
    const stub = await freshShow();
    const a = await connectDO(stub, "alice");
    const b = await connectDO(stub, "bob");
    expect(await b.next(isType("hello"))).toMatchObject({ clients: 2 });
    expect(await stub.notifyRole("alice", "viewer")).toBe(1);
    expect(await a.next(isType("role"))).toEqual({ type: "role", role: "viewer" });
    // Bob hears nothing about it; Alice is still connected (a presence update reaches her).
    const c = await connectDO(stub, "carol");
    expect(await a.next((m): m is never => m.type === "presence" && m.clients === 3)).toBeTruthy();
    expect(b.received.some((m) => m.type === "role")).toBe(false);
    for (const x of [a, b, c]) x.ws.close(1000);
  });
});

describe("ops: review hardening", () => {
  it("accepts only lowercase UUIDv7 ids", async () => {
    const stub = await freshShow();
    for (const id of [
      "not-a-uuid",
      "c1",
      "0190AAAA-0000-7000-8000-000000000000", // uppercase
      "0190aaaa-0000-4000-8000-000000000000", // v4
      "0190aaaa-0000-7000-c000-000000000000", // bad variant
    ]) {
      expect(await stub.mutate(ctx(), [cue(id)]), id).toMatchObject({ ok: false, status: 400 });
    }
    expect(await stub.mutate(ctx(), [cue(newId(), {}, { after: "not-a-uuid" })])).toMatchObject({
      ok: false,
      error: /after must be an id/,
    });
    ok(await stub.mutate(ctx(), [cue(newId())]));
  });

  it("rejects reserved custom keys", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(ctx(), [cue(id)]));
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const custom = JSON.parse(`{"${key}": 1}`) as Record<string, unknown>;
      expect(
        await stub.mutate(ctx(), [{ op: "update", table: "cues", id, fields: { custom } }]),
      ).toMatchObject({ ok: false, error: /not allowed/ });
    }
  });

  it("rejects creates and updates that would make a row over 512 KiB", async () => {
    const stub = await freshShow();
    const big = "x".repeat(99_000);
    const five = { description: big, sm_call: big, trigger_value: big, lx_cue: big, sq_cue: big };
    const id = newId();
    ok(await stub.mutate(ctx(), [cue(id, five)])); // ~495 KB fits
    expect(
      await stub.mutate(ctx(), [{ op: "update", table: "cues", id, fields: { timecode: big } }]),
    ).toMatchObject({ ok: false, status: 400, error: /exceed 512 KiB/ });
    expect(await stub.mutate(ctx(), [cue(newId(), { ...five, timecode: big })])).toMatchObject({
      ok: false,
      error: /exceed 512 KiB/,
    });
  });

  it("a create whose neighbour was deleted falls back to before, then the end of its scene", async () => {
    const stub = await freshShow();
    const [s1, s2, a, b, c, gone] = [newId(), newId(), newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "scenes", id: s1, fields: { name: "One" } },
        { op: "create", table: "scenes", id: s2, fields: { name: "Two" } },
        cue(a, { number: "1", scene_id: s1 }),
        cue(gone, { number: "1.5", scene_id: s1 }),
        cue(b, { number: "2", scene_id: s1 }),
        cue(c, { number: "10", scene_id: s2 }),
      ]),
    );
    // Someone else deletes the row our client was about to insert after.
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "cues", id: gone }]));

    // after: gone, before: b → before is used.
    const r1 = ok(
      await stub.mutate(ctx(), [
        cue(newId(), { number: "1.7", scene_id: s1 }, { after: gone, before: b }),
      ]),
    );
    expect(r1.ops[0]).toMatchObject({ op: "create", placement: { before: b } });

    // after: gone only → end of the new row's scene (after b, the last scene-1 cue).
    const r2 = ok(
      await stub.mutate(ctx(), [cue(newId(), { number: "2.5", scene_id: s1 }, { after: gone })]),
    );
    expect(r2.ops[0]).toMatchObject({ placement: { after: b } });

    // No cues in its scene (Unassigned) → end of the table.
    const r3 = ok(await stub.mutate(ctx(), [cue(newId(), { number: "99" }, { after: gone })]));
    expect(r3.ops[0]).toMatchObject({ placement: {} });

    // A placement that resolves is reported unchanged.
    const r4 = ok(await stub.mutate(ctx(), [cue(newId(), { number: "0" }, { after: null })]));
    expect(r4.ops[0]).toMatchObject({ placement: { after: null } });

    const order = (await snapshot(stub)).tables.cues.map((r) => r.number);
    expect(order).toEqual(["0", "1", "1.7", "2", "2.5", "10", "99"]);
  });
});
