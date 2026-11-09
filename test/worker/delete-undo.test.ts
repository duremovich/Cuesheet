// Undo of a delete (features/shared/restore.ts) against the real op engine: take the
// snapshot, delete, build the restore ops from the delete's resolved ops and the state
// before it (as the grids do), apply them, and the snapshot is back to what it was:
// rows (same ids, fields, authors, creation times), show order, links in chip order,
// references and custom link values the cascade cleared.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { customTableRef } from "../../src/shared/custom-fields";
import { newId } from "../../src/shared/ids";
import type { AnyOp, Op, SnapshotResponse } from "../../src/shared/ops";
import type { TableName } from "../../src/shared/tables";
import { deleteRestoreOps } from "../../src/web/features/shared/restore";
import { fromSnapshot } from "../../src/web/lib/show-state";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";

let seq = 0;
async function freshShow() {
  const name = `undo-${Date.now()}-${seq++}`;
  const stub = env.SHOW.get(env.SHOW.idFromName(name));
  await stub.sync(name, name);
  return stub;
}
type Stub = Awaited<ReturnType<typeof freshShow>>;

const ctx = (userId = "u-alice"): MutationContext => ({
  userId,
  role: "editor",
  clientId: `client-${userId}`,
});

function ok(r: MutateResult) {
  if (!r.ok) throw new Error(`mutate failed: ${r.error} (op ${r.opIndex})`);
  return r;
}

async function snapshot(stub: Stub): Promise<SnapshotResponse> {
  return JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
}

/** The snapshot minus what an undo legitimately changes: last-edit stamps, order keys. */
function comparable(snap: SnapshotResponse) {
  const tables: Record<string, unknown[]> = {};
  for (const [t, rows] of Object.entries(snap.tables)) {
    tables[t] = (rows as unknown as Record<string, unknown>[]).map(
      ({ updated_at: _a, updated_by: _b, order_key: _k, ...rest }) => rest,
    );
  }
  return { tables, joins: snap.joins };
}

/** Delete (as Alice), undo (as Bob, a few ms later), expect everything back. */
async function roundTrip(stub: Stub, deletes: Op[]) {
  const snap0 = await snapshot(stub);
  const before = fromSnapshot(snap0);
  const res = ok(await stub.mutate(ctx(), deletes));
  const after = fromSnapshot(await snapshot(stub));
  // Something really went: the test would pass vacuously otherwise.
  expect(comparable(await snapshot(stub))).not.toEqual(comparable(snap0));
  await new Promise((r) => setTimeout(r, 5));
  const exists = (t: TableName, id: string) => (after.tables[t] as Map<string, unknown>).has(id);
  const undo = deleteRestoreOps(before, res.ops, exists);
  ok(await stub.mutate(ctx("u-bob"), undo));
  expect(comparable(await snapshot(stub))).toEqual(comparable(snap0));
  return { res, undo };
}

const create = (table: TableName, id: string, fields: Record<string, unknown> = {}): Op => ({
  op: "create",
  table,
  id,
  fields,
});
const link = (table: TableName, id: string, field: string, targetId: string): Op => ({
  op: "link",
  table,
  id,
  field,
  targetId,
});
const del = (table: TableName, id: string): Op => ({ op: "delete", table, id });

/** A small show touching every kind of thing a delete cascades through. */
async function seed(stub: Stub) {
  const id = {
    s1: newId(),
    s2: newId(),
    wall: newId(),
    region: newId(),
    alice: newId(),
    bob: newId(),
    k1: newId(),
    k2: newId(),
    v1: newId(),
    v2: newId(),
    c1: newId(),
    c2: newId(),
    c3: newId(),
    c4: newId(),
    n1: newId(),
    n2: newId(),
    list: newId(),
    shot: newId(),
    net: newId(),
    r1: newId(),
    r2: newId(),
  };
  const field = (table: string, key: string, type: string, options = {}): AnyOp => ({
    op: "create",
    table: "custom_fields",
    id: newId(),
    fields: { table, key, label: key, type, options },
  });
  const ops: AnyOp[] = [
    create("scenes", id.s1, { number: "101", name: "Open" }),
    create("scenes", id.s2, { number: "102", name: "Train" }),
    create("surfaces", id.wall, { name: "WALL", width: 4 }),
    create("surfaces", id.region, { name: "WALL L", parent_id: id.wall }),
    create("persons", id.alice, { name: "Alice" }),
    create("persons", id.bob, { name: "Bob" }),
    { op: "create", table: "custom_tables", id: id.net, fields: { label: "Network" } },
    field(customTableRef(id.net), "ip", "text"),
    field("cues", "mood", "text"),
    field("cues", "port", "link", { target: customTableRef(id.net) }),
    field("content", "related", "link", { target: "cues" }),
    create("custom_rows", id.r1, { table_id: id.net, custom: { ip: "10.0.0.1" } }),
    create("custom_rows", id.r2, { table_id: id.net, custom: { ip: "10.0.0.2" } }),
    create("content", id.k1, { name: "101-001-RAIN", scene_id: id.s1, creator_id: id.alice }),
    create("content", id.k2, { name: "101-002-FOG", scene_id: id.s1 }),
    create("content_versions", id.v1, {
      content_id: id.k1,
      version: "V01",
      rendered_by: id.bob,
    }),
    create("content_versions", id.v2, { content_id: id.k1, version: "V02", is_current: true }),
    create("cues", id.c1, { number: "1", scene_id: id.s1 }),
    create("cues", id.c2, {
      number: "2",
      scene_id: id.s1,
      description: "rain",
      status: "Cued",
      custom: { mood: "wet", port: [id.r1, id.r2] },
    }),
    create("cues", id.c3, { number: "3", scene_id: id.s1 }),
    create("cues", id.c4, { number: "4", scene_id: id.s2 }),
    create("notes", id.n1, { body: "fix rain", status: "Done", scene_id: id.s1 }),
    create("notes", id.n2, { body: "louder", status: "Open" }),
    { op: "create", table: "shot_lists", id: id.list, fields: { name: "Day 1" } },
    create("shots", id.shot, { shot_list_id: id.list, number: "1" }),
    // Links, several per list so positions matter.
    link("cues", id.c2, "content", id.k2),
    link("cues", id.c2, "content", id.k1),
    link("cues", id.c2, "assignees", id.bob),
    link("cues", id.c2, "assignees", id.alice),
    link("notes", id.n1, "cues", id.c1),
    link("notes", id.n1, "cues", id.c2),
    link("notes", id.n1, "cues", id.c3),
    link("notes", id.n1, "content", id.k1),
    link("notes", id.n1, "assignees", id.alice),
    link("scenes", id.s1, "surfaces", id.wall),
    link("content", id.k1, "surfaces", id.region),
    link("shots", id.shot, "talent", id.alice),
    link("shots", id.shot, "content", id.k1),
    { op: "update", table: "content", id: id.k2, fields: { custom: { related: [id.c2, id.c3] } } },
  ];
  ok(await stub.mutate(ctx(), ops as Op[]));
  return id;
}

describe("undo of a delete restores the show exactly", () => {
  it("a cue with links, a custom link, script-free refs and a neighbour", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    const { res } = await roundTrip(stub, [del("cues", id.c2)]);
    // The cascade really touched links and a custom link value on content.
    const kinds = res.ops.map((o) => o.op);
    expect(kinds).toContain("unlink");
    expect(kinds).toContain("update");
  });

  it("two adjacent cues come back in their old order", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("cues", id.c3), del("cues", id.c2)]);
  });

  it("a scene: its cues, content and notes get their scene back; its surfaces relink", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("scenes", id.s1)]);
  });

  it("a scene and one of its cues in one batch, in either order", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("scenes", id.s1), del("cues", id.c2)]);
    await roundTrip(stub, [del("cues", id.c1), del("scenes", id.s1)]);
  });

  it("content with versions (current one too), surfaces, shots and notes links", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("content", id.k1)]);
  });

  it("people: assignees, talent, creator and rendered-by come back", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("persons", id.alice), del("persons", id.bob)]);
  });

  it("a surface with a region: the region's parent comes back", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("surfaces", id.wall)]);
  });

  it("shots, notes (author, created and completed times) and custom rows", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    await roundTrip(stub, [del("shots", id.shot)]);
    await roundTrip(stub, [del("notes", id.n1), del("notes", id.n2)]);
    await roundTrip(stub, [del("custom_rows", id.r1), del("custom_rows", id.r2)]);
  });

  it("leaves out what someone else deleted meanwhile instead of failing", async () => {
    const stub = await freshShow();
    const id = await seed(stub);
    const before = fromSnapshot(await snapshot(stub));
    const res = ok(await stub.mutate(ctx(), [del("cues", id.c2)]));
    // Meanwhile: Bob's person and the k2 content are deleted by someone else.
    ok(await stub.mutate(ctx("u-carol"), [del("persons", id.bob), del("content", id.k2)]));
    const now = fromSnapshot(await snapshot(stub));
    const exists = (t: TableName, x: string) => (now.tables[t] as Map<string, unknown>).has(x);
    ok(await stub.mutate(ctx("u-bob"), deleteRestoreOps(before, res.ops, exists)));
    const snap = await snapshot(stub);
    const c2 = snap.tables.cues.find((c) => c.id === id.c2) as unknown as Record<string, unknown>;
    expect(c2?.description).toBe("rain");
    expect(snap.joins.cueContent[id.c2]).toEqual([id.k1]);
    expect(snap.joins.cueAssignees[id.c2]).toEqual([id.alice]);
    expect(snap.joins.noteCues[id.n1]).toEqual([id.c1, id.c2, id.c3]);
  });
});
