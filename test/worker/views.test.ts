// Saved views (M2a): the `views` table in the op engine, the personal-view exception to
// role enforcement, default exclusivity, config validation and the lazily seeded defaults.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Role } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { Op, SnapshotResponse } from "../../src/shared/ops";
import type { ViewRow } from "../../src/shared/tables";
import { defaultViewConfig, type ViewConfig } from "../../src/shared/views";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { api, connectDO, createShow, isType, loginAdmin, newUser, post } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `views-${Date.now()}-${seq++}`;
  const stub = env.SHOW.get(env.SHOW.idFromName(name));
  await stub.sync(name, name);
  return stub;
}

const ctx = (role: Role, userId: string): MutationContext => ({
  userId,
  role,
  clientId: `client-${userId}`,
});
const editor = ctx("editor", "u-editor");
const viewer = ctx("viewer", "u-viewer");
const commenter = ctx("commenter", "u-commenter");

async function snapshot(stub: { snapshotJson(): Promise<string> }): Promise<SnapshotResponse> {
  return JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
}

function ok(r: MutateResult) {
  if (!r.ok) throw new Error(`mutate failed: ${r.error} (op ${r.opIndex})`);
  return r;
}

const config = (patch: Partial<ViewConfig> = {}): ViewConfig => ({
  ...defaultViewConfig("cues"),
  ...patch,
});

const createView = (id: string, fields: Record<string, unknown>): Op => ({
  op: "create",
  table: "views",
  id,
  fields: { table: "cues", name: "V", config: config(), ...fields },
});

const views = async (stub: { snapshotJson(): Promise<string> }) =>
  (await snapshot(stub)).tables.views as ViewRow[];

describe("views: lazy defaults", () => {
  it("a new show has one shared default view per data table, without a version bump", async () => {
    const stub = await freshShow();
    const snap = await snapshot(stub);
    expect(snap.version).toBe(0);
    const list = snap.tables.views;
    expect(list.map((v) => v.table).sort()).toEqual(
      ["content", "cues", "notes", "persons", "scenes"].sort(),
    );
    for (const v of list) {
      expect(v).toMatchObject({ owner_user_id: null, is_default: true, created_by: "system" });
    }
    const cues = list.find((v) => v.table === "cues");
    expect(cues?.config).toMatchObject({ group: { key: "scene" }, sortMode: "none", fields: [] });
    expect(list.find((v) => v.table === "notes")?.config).toMatchObject({
      group: { key: "status" },
    });
    expect(list.find((v) => v.table === "scenes")?.config).toMatchObject({ group: { key: null } });
    // Views don't count as data (an empty show can still be imported into).
    expect(await stub.hasData()).toBe(false);
  });

  it("an existing show without views gets them when its object starts", async () => {
    const stub = await freshShow();
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM views");
    });
    expect(await views(stub)).toHaveLength(0);
    await evictDurableObject(stub);
    expect(await views(stub)).toHaveLength(5);
    // A table that still has a shared view isn't seeded again.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`DELETE FROM views WHERE "table" = 'notes'`);
    });
    const before = (await views(stub)).map((v) => v.id);
    await evictDurableObject(stub);
    const after = await views(stub);
    expect(after).toHaveLength(5);
    expect(after.filter((v) => before.includes(v.id))).toHaveLength(4);
  });
});

describe("views: ops and roles", () => {
  it("editors create, update and delete shared views; config round-trips as JSON", async () => {
    const stub = await freshShow();
    const id = newId();
    const cfg = config({
      filters: [{ key: "status", op: "is", value: "Cued" }],
      colorRules: [
        {
          when: [{ key: "status", op: "is", value: "Cued" }],
          mode: "and",
          target: "row",
          color: "green",
        },
      ],
    });
    ok(await stub.mutate(editor, [createView(id, { name: "Tech", config: cfg, position: 1 })]));
    let v = (await views(stub)).find((x) => x.id === id);
    expect(v).toMatchObject({ name: "Tech", owner_user_id: null, is_default: false, config: cfg });
    ok(
      await stub.mutate(editor, [{ op: "update", table: "views", id, fields: { name: "Tech 2" } }]),
    );
    v = (await views(stub)).find((x) => x.id === id);
    expect(v?.name).toBe("Tech 2");
    ok(await stub.mutate(editor, [{ op: "delete", table: "views", id }]));
    expect((await views(stub)).some((x) => x.id === id)).toBe(false);
  });

  it("a view without a config gets its table's default", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(
      await stub.mutate(editor, [
        { op: "create", table: "views", id, fields: { table: "notes", name: "N" } },
      ]),
    );
    expect((await views(stub)).find((x) => x.id === id)?.config).toEqual(
      defaultViewConfig("notes"),
    );
  });

  it("viewers and commenters manage their own personal views, and nothing else", async () => {
    const stub = await freshShow();
    const shared = (await views(stub)).find((v) => v.table === "cues") as ViewRow;
    for (const who of [viewer, commenter]) {
      const mine = newId();
      ok(await stub.mutate(who, [createView(mine, { owner_user_id: who.userId })]));
      ok(
        await stub.mutate(who, [
          {
            op: "update",
            table: "views",
            id: mine,
            fields: { name: "Mine", config: config({ rowHeight: "tall" }) },
          },
        ]),
      );
      const row = (await views(stub)).find((v) => v.id === mine);
      expect(row).toMatchObject({
        name: "Mine",
        owner_user_id: who.userId,
        created_by: who.userId,
      });
      expect((row?.config as unknown as ViewConfig | undefined)?.rowHeight).toBe("tall");

      // Shared views: no create, update or delete.
      expect(await stub.mutate(who, [createView(newId(), {})])).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(
        await stub.mutate(who, [
          { op: "update", table: "views", id: shared.id, fields: { name: "x" } },
        ]),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        await stub.mutate(who, [{ op: "delete", table: "views", id: shared.id }]),
      ).toMatchObject({ ok: false, status: 403 });
      // Not a view for someone else either.
      expect(
        await stub.mutate(who, [createView(newId(), { owner_user_id: "someone-else" })]),
      ).toMatchObject({ ok: false, status: 403 });
      // Still no data changes.
      expect(
        await stub.mutate(who, [{ op: "create", table: "cues", id: newId(), fields: {} }]),
      ).toMatchObject({ ok: false, status: 403 });
      ok(await stub.mutate(who, [{ op: "delete", table: "views", id: mine }]));
    }
  });

  it("nobody (not even an editor) changes someone else's personal view", async () => {
    const stub = await freshShow();
    const theirs = newId();
    ok(await stub.mutate(viewer, [createView(theirs, { owner_user_id: viewer.userId })]));
    expect(
      await stub.mutate(editor, [
        { op: "update", table: "views", id: theirs, fields: { name: "x" } },
      ]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(await stub.mutate(editor, [{ op: "delete", table: "views", id: theirs }])).toMatchObject(
      { ok: false, status: 403 },
    );
  });

  it("table and owner can't change; configs are validated", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(editor, [createView(id, {})]));
    const bad = async (fields: Record<string, unknown>) =>
      stub.mutate(editor, [{ op: "update", table: "views", id, fields }]);
    expect(await bad({ table: "notes" })).toMatchObject({ ok: false, status: 400 });
    expect(await bad({ owner_user_id: editor.userId })).toMatchObject({ ok: false, status: 400 });
    expect(await bad({ config: { filters: "nope" } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/filters/),
    });
    expect(
      await bad({ config: config({ filters: [{ key: "status", op: "like" as never }] }) }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/operator/) });
    expect(
      await bad({
        config: config({
          colorRules: [{ when: [], mode: "and", target: "row", color: "black" as never }],
        }),
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/color/) });
    expect(await bad({ config: null })).toMatchObject({ ok: false });
    expect(await stub.mutate(editor, [createView(newId(), { table: "views" })])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/views.table/),
    });
  });
});

describe("views: config validation against the table", () => {
  it("rebuilds the config from known keys, dropping unknown ones", async () => {
    const stub = await freshShow();
    const id = newId();
    const raw = {
      ...config({
        filters: [{ key: "status", op: "is", value: "Cued", extra: 1 } as never],
      }),
      somethingNew: { a: 1 },
      group: { key: "scene", junk: true },
    };
    ok(await stub.mutate(editor, [createView(id, { config: raw })]));
    const saved = (await views(stub)).find((v) => v.id === id)?.config as Record<string, unknown>;
    expect(saved).not.toHaveProperty("somethingNew");
    expect(saved.group).toEqual({ key: "scene" });
    expect(saved.filters).toEqual([{ key: "status", op: "is", value: "Cued" }]);
  });

  it("refuses unknown fields, wrong operators and values, bad grouping/sorts/frozen", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(editor, [createView(id, {})]));
    const bad = (patch: Partial<ViewConfig>) =>
      stub.mutate(editor, [
        { op: "update", table: "views", id, fields: { config: config(patch) } },
      ]);
    const cases: [Partial<ViewConfig>, RegExp][] = [
      [{ filters: [{ key: "nope", op: "is", value: "x" }] }, /no field "nope"/],
      [{ filters: [{ key: "status", op: "gt", value: "x" }] }, /doesn't apply/],
      [{ filters: [{ key: "status", op: "isEmpty", value: "x" }] }, /takes no value/],
      [{ filters: [{ key: "status", op: "anyOf", value: "Cued" }] }, /takes a list/],
      [{ filters: [{ key: "number", op: "gt", value: ["1"] }] }, /number or text/],
      [{ group: { key: "description" } }, /can't group/],
      [{ group: { key: "open_notes" } }, /no column/],
      [{ fields: [{ key: "ghost" }] }, /no column "ghost"/],

      [
        {
          sorts: [
            { key: "number", dir: "asc" },
            { key: "number", dir: "desc" },
          ],
        },
        /twice/,
      ],
      [{ sorts: [{ key: "open_notes", dir: "asc" }] }, /no column/],
      [
        {
          colorRules: [{ when: [], mode: "and", target: { cell: "ghost" }, color: "red" }],
        },
        /no column "ghost"/,
      ],
    ];
    for (const [patch, error] of cases) {
      expect(await bad(patch)).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringMatching(error),
      });
    }
    // People have 6 columns: 7 frozen is too many.
    expect(
      await stub.mutate(editor, [
        createView(newId(), {
          table: "persons",
          config: { ...defaultViewConfig("persons"), frozenCount: 7 },
        }),
      ]),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/frozenCount/) });
    // Extra fields can be filtered and colored by; incomplete filters are fine.
    ok(
      await bad({
        filters: [
          { key: "open_notes", op: "gt", value: 0 },
          { key: "status", op: "is" },
        ],
      }),
    );
  });

  it("keeps a table's last shared view and caps personal views at 50", async () => {
    const stub = await freshShow();
    const seeded = (await views(stub)).find((v) => v.table === "cues") as ViewRow;
    expect(
      await stub.mutate(editor, [{ op: "delete", table: "views", id: seeded.id }]),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/at least one shared/),
    });
    const other = newId();
    ok(await stub.mutate(editor, [createView(other, {})]));
    ok(await stub.mutate(editor, [{ op: "delete", table: "views", id: seeded.id }]));

    const ops = Array.from({ length: 50 }, () =>
      createView(newId(), { owner_user_id: viewer.userId }),
    );
    ok(await stub.mutate(viewer, ops));
    expect(
      await stub.mutate(viewer, [createView(newId(), { owner_user_id: viewer.userId })]),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/At most 50/) });
    // Another table has its own allowance.
    ok(
      await stub.mutate(viewer, [
        createView(newId(), {
          owner_user_id: viewer.userId,
          table: "notes",
          config: defaultViewConfig("notes"),
        }),
      ]),
    );
  });
});

describe("views: default exclusivity", () => {
  it("setting is_default on a shared view clears it on the table's other shared views", async () => {
    const stub = await freshShow();
    const seeded = (await views(stub)).find((v) => v.table === "cues") as ViewRow;
    const notesDefault = (await views(stub)).find((v) => v.table === "notes") as ViewRow;
    const id = newId();
    ok(await stub.mutate(editor, [createView(id, { name: "Tech" })]));
    const r = ok(
      await stub.mutate(editor, [
        { op: "update", table: "views", id, fields: { is_default: true } },
      ]),
    );
    // The clearing is part of the resolved ops (clients replay it).
    expect(r.ops).toMatchObject([
      { op: "update", table: "views", id, fields: { is_default: true } },
      { op: "update", table: "views", id: seeded.id, fields: { is_default: false } },
    ]);
    const list = await views(stub);
    expect(list.find((v) => v.id === id)?.is_default).toBe(true);
    expect(list.find((v) => v.id === seeded.id)?.is_default).toBe(false);
    // Other tables keep theirs.
    expect(list.find((v) => v.id === notesDefault.id)?.is_default).toBe(true);

    // Creating a view as the default works the same way.
    const third = newId();
    ok(await stub.mutate(editor, [createView(third, { is_default: true })]));
    const after = await views(stub);
    expect(after.filter((v) => v.table === "cues" && v.is_default).map((v) => v.id)).toEqual([
      third,
    ]);
  });

  it("a personal view can't be the default", async () => {
    const stub = await freshShow();
    expect(
      await stub.mutate(viewer, [
        createView(newId(), { owner_user_id: viewer.userId, is_default: true }),
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/shared view/) });
  });
});

describe("views: HTTP", () => {
  it("a viewer's /mutate may change their own views but no show data", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Views HTTP");
    const v = await newUser(admin, "Vic Viewer");
    const added = await post(
      `/api/shows/${show.id}/members`,
      { email: v.email, role: "viewer" },
      admin,
    );
    expect(added.status).toBe(201);
    const mutate = (ops: Op[]) =>
      post(`/api/shows/${show.id}/mutate`, { clientId: "c", ops }, v.cookie);
    const id = newId();
    const res = await mutate([createView(id, { owner_user_id: v.id, name: "My view" })]);
    expect(res.status).toBe(200);
    const denied = await mutate([{ op: "create", table: "cues", id: newId(), fields: {} }]);
    expect(denied.status).toBe(403);
    const shared = await mutate([createView(newId(), {})]);
    expect(shared.status).toBe(403);

    // Personal views are private: the admin's snapshot and history don't have it.
    const adminSnap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie: admin })
    ).json()) as SnapshotResponse;
    expect(adminSnap.tables.views.some((x) => x.id === id)).toBe(false);
    const mineSnap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie: v.cookie })
    ).json()) as SnapshotResponse;
    expect(mineSnap.tables.views.some((x) => x.id === id)).toBe(true);
    const hist = (await (
      await api(`/api/shows/${show.id}/history?table=views`, { cookie: admin })
    ).json()) as { changes: { recordId: string }[] };
    expect(hist.changes.some((c) => c.recordId === id)).toBe(false);
  });
});

describe("views: personal views are private", () => {
  it("user B's snapshot and socket never see A's personal view; B's version still advances", async () => {
    const stub = await freshShow();
    const a = ctx("viewer", "u-a");
    const sockA = await connectDO(stub, "u-a");
    const sockB = await connectDO(stub, "u-b");
    await sockA.next(isType("version"));
    await sockB.next(isType("version"));

    const id = newId();
    const created = ok(await stub.mutate(a, [createView(id, { owner_user_id: "u-a" })]));
    const toA = await sockA.next(isType("ops"));
    expect(toA.ops).toMatchObject([{ op: "create", table: "views", id }]);
    const toB = await sockB.next(isType("ops"));
    expect(toB).toMatchObject({ prevVersion: created.prevVersion, version: created.version });
    expect(toB.ops).toEqual([]);

    // A batch mixing shared and private changes: B gets only the shared part.
    const cueId = newId();
    ok(
      await stub.mutate(editor, [
        { op: "create", table: "cues", id: cueId, fields: { number: "1" } },
      ]),
    );
    await sockA.next(isType("ops"));
    expect((await sockB.next(isType("ops"))).ops).toMatchObject([{ table: "cues", id: cueId }]);
    ok(
      await stub.mutate(a, [
        { op: "update", table: "views", id, fields: { name: "Secret" } },
        { op: "delete", table: "views", id },
      ]),
    );
    expect((await sockA.next(isType("ops"))).ops.map((o) => o.op)).toEqual(["update", "delete"]);
    expect((await sockB.next(isType("ops"))).ops).toEqual([]);
    for (const m of [...sockB.received]) {
      expect(JSON.stringify(m)).not.toContain(id);
    }

    // Snapshots and history per user.
    const id2 = newId();
    ok(await stub.mutate(a, [createView(id2, { owner_user_id: "u-a" })]));
    const forB = JSON.parse(await stub.snapshotJson("u-b")) as SnapshotResponse;
    const forA = JSON.parse(await stub.snapshotJson("u-a")) as SnapshotResponse;
    expect(forB.tables.views.some((v) => v.id === id2)).toBe(false);
    expect(forB.tables.views.filter((v) => v.owner_user_id === null)).toHaveLength(5);
    expect(forA.tables.views.some((v) => v.id === id2)).toBe(true);
    expect((await stub.history({ table: "views" }, "u-b")).some((h) => h.recordId === id2)).toBe(
      false,
    );
    expect((await stub.history({ table: "views" }, "u-a")).some((h) => h.recordId === id2)).toBe(
      true,
    );
  });
});
