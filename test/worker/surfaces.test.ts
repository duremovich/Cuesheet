// Surfaces (M3b): the table's ops, measurement validation, parent cycles, cascades, the
// scene/content links, the `meta` op (show default unit), and the Surfaces CSV import.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import breakdown from "../../examples/Breakdown-Grid view.csv?raw";
import surfacesCsv from "../../examples/Surfaces-Gallery.csv?raw";
import type { Role } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type {
  AnyOp,
  HistoryResponse,
  ImportResponse,
  SnapshotResponse,
} from "../../src/shared/ops";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { api, connectDO, createShow, isType, loginAdmin, ORIGIN, post } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `surfaces-${Date.now()}-${seq++}`;
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

function fail(r: MutateResult) {
  if (r.ok) throw new Error("expected the batch to fail");
  return r;
}

const surface = (id: string, fields: Record<string, unknown> = {}): AnyOp => ({
  op: "create",
  table: "surfaces",
  id,
  fields,
});

describe("surfaces: ops", () => {
  it("creates in show order with measurements in meters", async () => {
    const stub = await freshShow();
    const [a, b] = [newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        surface(a, { name: "L PRO", channel: "CH02", width: 4.5, height: 4, lens_ratio: 1.5 }),
        surface(b, { name: "C WALL", pixel_width: 1920, pixel_height: 1080 }),
      ]),
    );
    ok(await stub.mutate(ctx(), [{ op: "move", table: "surfaces", id: b, after: null }]));
    const snap = await snapshot(stub);
    expect(snap.tables.surfaces.map((s) => s.name)).toEqual(["C WALL", "L PRO"]);
    expect(snap.tables.surfaces[1]).toMatchObject({
      width: 4.5,
      height: 4,
      lens_ratio: 1.5,
      parent_id: null,
      throw_distance: null,
    });
  });

  it("rejects negative or non-numeric lengths", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(ctx(), [surface(id, { name: "X" })]));
    for (const width of [-1, "4.5 m", Number.NaN]) {
      const r = fail(
        await stub.mutate(ctx(), [{ op: "update", table: "surfaces", id, fields: { width } }]),
      );
      expect(r.error).toMatch(/surfaces.width must be a length in meters/);
    }
    ok(await stub.mutate(ctx(), [{ op: "update", table: "surfaces", id, fields: { width: 0 } }]));
  });

  it("refuses parent cycles (self, direct, deep)", async () => {
    const stub = await freshShow();
    const [a, b, c] = [newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        surface(a, { name: "A" }),
        surface(b, { name: "B", parent_id: a }),
        surface(c, { name: "C", parent_id: b }),
      ]),
    );
    const self = fail(
      await stub.mutate(ctx(), [
        { op: "update", table: "surfaces", id: a, fields: { parent_id: a } },
      ]),
    );
    expect(self.error).toMatch(/can't be inside itself/);
    const deep = fail(
      await stub.mutate(ctx(), [
        { op: "update", table: "surfaces", id: a, fields: { parent_id: c } },
      ]),
    );
    expect(deep.error).toMatch(/can't be inside itself/);
    // A create naming itself as parent fails (the row doesn't exist yet: not found).
    const d = newId();
    expect(fail(await stub.mutate(ctx(), [surface(d, { parent_id: d })])).error).toMatch(
      /not found/,
    );
    // Moving a subtree elsewhere is fine.
    const e = newId();
    ok(await stub.mutate(ctx(), [surface(e, { name: "E" })]));
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "surfaces", id: b, fields: { parent_id: e } },
      ]),
    );
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "surfaces", id: a, fields: { parent_id: c } },
      ]),
    );
  });

  it("links scenes and content; deleting cascades links and parent refs", async () => {
    const stub = await freshShow();
    const [p, child, scene, content] = [newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        surface(p, { name: "L PRO" }),
        surface(child, { name: "L PRO TOP", parent_id: p }),
        { op: "create", table: "scenes", id: scene, fields: { number: "101" } },
        { op: "create", table: "content", id: content, fields: { name: "101-001-X" } },
        { op: "link", table: "scenes", id: scene, field: "surfaces", targetId: p },
        { op: "link", table: "scenes", id: scene, field: "surfaces", targetId: child },
        { op: "link", table: "content", id: content, field: "surfaces", targetId: child },
      ]),
    );
    let snap = await snapshot(stub);
    expect(snap.joins.sceneSurfaces[scene]).toEqual([p, child]);
    expect(snap.joins.contentSurfaces[content]).toEqual([child]);

    const del = ok(await stub.mutate(ctx(), [{ op: "delete", table: "surfaces", id: p }]));
    expect(del.ops.map((o) => `${o.op}:${"table" in o ? o.table : ""}`)).toEqual([
      "unlink:scenes",
      "update:surfaces",
      "delete:surfaces",
    ]);
    snap = await snapshot(stub);
    expect(snap.joins.sceneSurfaces[scene]).toEqual([child]);
    expect(snap.tables.surfaces.map((s) => [s.name, s.parent_id])).toEqual([["L PRO TOP", null]]);

    ok(await stub.mutate(ctx(), [{ op: "delete", table: "content", id: content }]));
    snap = await snapshot(stub);
    expect(snap.joins.contentSurfaces[content]).toBeUndefined();
  });

  it("commenters and viewers can't change surfaces", async () => {
    const stub = await freshShow();
    for (const role of ["commenter", "viewer"] as const) {
      const r = fail(await stub.mutate(ctx(role, `u-${role}`), [surface(newId(), { name: "X" })]));
      expect(r.status).toBe(403);
    }
  });
});

describe("show settings: the meta op", () => {
  it("sets the default unit, logs it, bumps the version, broadcasts, and snapshots it", async () => {
    const stub = await freshShow();
    expect((await snapshot(stub)).meta).toEqual({ default_unit: null });
    const sock = await connectDO(stub);
    await sock.next(isType("version"));
    const r = ok(await stub.mutate(ctx(), [{ op: "meta", fields: { default_unit: "ft-in" } }]));
    expect(r.version).toBe(r.prevVersion + 1);
    expect(r.ops).toEqual([{ op: "meta", fields: { default_unit: "ft-in" } }]);
    const msg = await sock.next(isType("ops"));
    expect(msg.ops).toEqual([{ op: "meta", fields: { default_unit: "ft-in" } }]);
    sock.ws.close(1000);
    expect((await snapshot(stub)).meta).toEqual({ default_unit: "ft-in" });
    const history = await stub.history({ table: "meta" });
    expect(history[0]).toMatchObject({ field: "default_unit", old: "null", new: '"ft-in"' });
    // Unchanged: no new version.
    const same = ok(await stub.mutate(ctx(), [{ op: "meta", fields: { default_unit: "ft-in" } }]));
    expect(same.version).toBe(same.prevVersion);
    ok(await stub.mutate(ctx(), [{ op: "meta", fields: { default_unit: null } }]));
    expect((await snapshot(stub)).meta).toEqual({ default_unit: null });
  });

  it("validates the unit, the setting and the role", async () => {
    const stub = await freshShow();
    expect(
      fail(await stub.mutate(ctx(), [{ op: "meta", fields: { default_unit: "furlong" } } as never]))
        .error,
    ).toMatch(/default_unit must be one of m, cm, mm, ft-in, ft, in/);
    expect(
      fail(await stub.mutate(ctx(), [{ op: "meta", fields: { name: "x" } } as never])).error,
    ).toMatch(/unknown show setting name/);
    const viewer = fail(
      await stub.mutate(ctx("viewer", "u-v"), [{ op: "meta", fields: { default_unit: "cm" } }]),
    );
    expect(viewer.status).toBe(403);
  });

  it("works through POST /mutate", async () => {
    const cookie = await loginAdmin();
    const show = await createShow(cookie, "Units");
    const res = await post(
      `/api/shows/${show.id}/mutate`,
      { clientId: "c1", ops: [{ op: "meta", fields: { default_unit: "cm" } }] },
      cookie,
    );
    expect(res.status).toBe(200);
    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    expect(snap.meta.default_unit).toBe("cm");
  });
});

describe("surfaces: views", () => {
  it("seeds the shared default view and accepts measurement filters and a unit", async () => {
    const stub = await freshShow();
    const snap = await snapshot(stub);
    const view = snap.tables.views.find((v) => v.table === "surfaces");
    expect(view?.name).toBe("All surfaces");
    const config = {
      filters: [{ key: "width", op: "gt", value: "4 m" }],
      filterMode: "and",
      sorts: [{ key: "ppi", dir: "desc" }],
      sortMode: "live",
      group: { key: null },
      fields: [],
      rowHeight: "normal",
      frozenCount: 1,
      colorRules: [
        { when: [{ key: "ppi", op: "lt", value: 30 }], mode: "and", target: "row", color: "red" },
      ],
      unit: "ft-in",
    };
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "views", id: view?.id as string, fields: { config } },
      ]),
    );
    expect((await snapshot(stub)).tables.views.find((v) => v.id === view?.id)?.config).toEqual(
      config,
    );
    const bad = fail(
      await stub.mutate(ctx(), [
        {
          op: "update",
          table: "views",
          id: view?.id as string,
          fields: { config: { ...config, unit: "parsec" } },
        },
      ]),
    );
    expect(bad.error).toMatch(/config.unit must be one of/);
    const badOp = fail(
      await stub.mutate(ctx(), [
        {
          op: "update",
          table: "views",
          id: view?.id as string,
          fields: {
            config: { ...config, filters: [{ key: "width", op: "contains", value: "4" }] },
          },
        },
      ]),
    );
    expect(badOp.error).toMatch(/"contains" doesn't apply to width/);
  });
});

describe("surfaces: Airtable import", () => {
  it("imports Surfaces-Gallery.csv with regions, alongside the Breakdown", async () => {
    const cookie = await loginAdmin();
    const show = await createShow(cookie, "Surfaces import");
    const form = new FormData();
    form.append("files", new File([surfacesCsv], "Surfaces-Gallery.csv", { type: "text/csv" }));
    form.append("files", new File([breakdown], "Breakdown-Grid view.csv", { type: "text/csv" }));
    const res = await api(`/api/shows/${show.id}/import/airtable`, {
      method: "POST",
      body: form,
      cookie,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResponse;
    expect(body.created).toMatchObject({ surfaces: 15, scenes: 28 });
    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    const byChannel = new Map(snap.tables.surfaces.map((s) => [s.channel, s]));
    expect(snap.tables.surfaces.map((s) => s.channel).slice(0, 4)).toEqual([
      "CH01",
      "CH02",
      "CH02.1",
      "CH02.2",
    ]);
    expect(byChannel.get("CH20")).toMatchObject({ name: "FULL WALL", width: 16.5, height: 4 });
    expect(byChannel.get("CH10.2")?.parent_id).toBe(byChannel.get("CH10")?.id);
    expect(byChannel.get("CH03")?.parent_id).toBeNull();
    const history = (await (
      await api(`/api/shows/${show.id}/history?table=surfaces&limit=1000`, { cookie })
    ).json()) as HistoryResponse;
    expect(history.changes.filter((c) => c.field === "*")).toHaveLength(15);
  });
});
