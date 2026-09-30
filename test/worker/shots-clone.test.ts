// M5a: shot lists and shots (ops, options, links, cascades) and the clone / template route.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CloneShowResponse, ShowsResponse } from "../../src/shared/api";
import { customTableRef } from "../../src/shared/custom-fields";
import { newId } from "../../src/shared/ids";
import type { AnyOp, SnapshotResponse } from "../../src/shared/ops";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { api, createShow, loginAdmin, newUser, post } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `shots-${Date.now()}-${seq++}`;
  const stub = env.SHOW.get(env.SHOW.idFromName(name));
  await stub.sync(name, name);
  return stub;
}
const ctx: MutationContext = { userId: "u", role: "editor", clientId: "c" };
const snapshot = async (stub: { snapshotJson(): Promise<string> }) =>
  JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
function ok(r: MutateResult) {
  if (!r.ok) throw new Error(`mutate failed: ${r.error} (op ${r.opIndex})`);
  return r;
}
function fail(r: MutateResult) {
  if (r.ok) throw new Error("expected the batch to fail");
  return r;
}

describe("shots", () => {
  it("ordered shots in a list with options, links, attachments field and cascades", async () => {
    const stub = await freshShow();
    const [list, s1, s2, person, content] = [newId(), newId(), newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx, [
        {
          op: "create",
          table: "shot_lists",
          id: list,
          fields: { name: "Day 1", shoot_date: "2026-10-02" },
        },
        { op: "create", table: "persons", id: person, fields: { name: "Alex" } },
        { op: "create", table: "content", id: content, fields: { name: "101-001-X" } },
        {
          op: "create",
          table: "shots",
          id: s1,
          fields: {
            shot_list_id: list,
            number: "1",
            group: "Train",
            framing: "WS",
            status: "Planned",
            resolution: { w: 3840, h: 2160 },
            frame_rate: 23.976,
            duration: "0:00:12",
          },
        },
        { op: "create", table: "shots", id: s2, fields: { shot_list_id: list, number: "2" } },
        { op: "link", table: "shots", id: s1, field: "talent", targetId: person },
        { op: "link", table: "shots", id: s1, field: "content", targetId: content },
        { op: "move", table: "shots", id: s2, after: null },
      ]),
    );
    let snap = await snapshot(stub);
    expect(snap.tables.shots.map((s) => s.number)).toEqual(["2", "1"]);
    expect(snap.joins.shotTalent[s1]).toEqual([person]);
    expect(snap.joins.shotContent[s1]).toEqual([content]);
    expect(snap.fieldOptions["shots.framing"]?.map((o) => o.value)).toEqual([
      "WS",
      "MS",
      "CU",
      "ECU",
      "OTS",
      "Insert",
    ]);
    // Options and shapes are checked; a shot needs a list.
    fail(
      await stub.mutate(ctx, [{ op: "update", table: "shots", id: s1, fields: { framing: "XL" } }]),
    );
    fail(
      await stub.mutate(ctx, [
        { op: "update", table: "shots", id: s1, fields: { resolution: "4k" } },
      ]),
    );
    fail(
      await stub.mutate(ctx, [
        { op: "create", table: "shots", id: newId(), fields: { number: "3" } },
      ]),
    );
    // The default view groups by `group`.
    expect(snap.tables.views.find((v) => v.table === "shots")?.config).toMatchObject({
      group: { key: "group" },
    });
    // Deleting a person unlinks; deleting the list deletes its shots.
    ok(await stub.mutate(ctx, [{ op: "delete", table: "persons", id: person }]));
    snap = await snapshot(stub);
    expect(snap.joins.shotTalent[s1]).toBeUndefined();
    const r = ok(await stub.mutate(ctx, [{ op: "delete", table: "shot_lists", id: list }]));
    expect(r.ops.filter((o) => o.op === "delete" && o.table === "shots")).toHaveLength(2);
    snap = await snapshot(stub);
    expect(snap.tables.shots).toHaveLength(0);
    expect(snap.joins.shotContent[s1]).toBeUndefined();
  });

  it("commenters and viewers can't touch shots", async () => {
    const stub = await freshShow();
    const list = newId();
    ok(
      await stub.mutate(ctx, [
        { op: "create", table: "shot_lists", id: list, fields: { name: "L" } },
      ]),
    );
    for (const role of ["commenter", "viewer"] as const) {
      const r = fail(
        await stub.mutate({ ...ctx, role }, [
          { op: "create", table: "shots", id: newId(), fields: { shot_list_id: list } },
        ]),
      );
      expect(r.status).toBe(403);
    }
  });
});

describe("clone / templates", () => {
  it("copies structure (scenes optional), never data; roles; templates listed", async () => {
    const admin = await loginAdmin();
    const source = await createShow(admin, "clone-source");
    const [scene, surface, region, cue, table, cf, tf, view, list] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    const ops: AnyOp[] = [
      { op: "meta", fields: { default_unit: "ft-in" } },
      { op: "create", table: "surfaces", id: surface, fields: { name: "WALL", width: 4 } },
      {
        op: "create",
        table: "surfaces",
        id: region,
        fields: { name: "WALL L", parent_id: surface },
      },
      { op: "create", table: "scenes", id: scene, fields: { number: "101", name: "Open" } },
      { op: "link", table: "scenes", id: scene, field: "surfaces", targetId: surface },
      { op: "create", table: "cues", id: cue, fields: { number: "1", scene_id: scene } },
      { op: "create", table: "custom_tables", id: table, fields: { label: "Network" } },
      {
        op: "create",
        table: "custom_fields",
        id: tf,
        fields: { table: customTableRef(table), key: "ip", label: "IP", type: "text", options: {} },
      },
      {
        op: "create",
        table: "custom_fields",
        id: cf,
        fields: {
          table: "cues",
          key: "cam",
          label: "Cam",
          type: "select",
          options: { choices: [{ value: "A", color: "red" }] },
        },
      },
      {
        op: "create",
        table: "custom_rows",
        id: newId(),
        fields: { table_id: table, custom: { ip: "10.0.0.1" } },
      },
      {
        op: "create",
        table: "views",
        id: view,
        fields: {
          table: "cues",
          name: "By cam",
          config: {
            filters: [{ key: "scene", op: "is", value: scene }],
            filterMode: "and",
            sorts: [],
            sortMode: "none",
            group: { key: "custom.cam" },
            fields: [],
            rowHeight: "normal",
            frozenCount: 1,
            colorRules: [],
          },
        },
      },
      { op: "create", table: "shot_lists", id: list, fields: { name: "Day 1" } },
    ];
    expect(
      (await post(`/api/shows/${source.id}/mutate`, { clientId: "c", ops }, admin)).status,
    ).toBe(200);

    // Viewers can't copy; strangers get 404.
    const viewer = await newUser(admin, "Viewer");
    await post(`/api/shows/${source.id}/members`, { email: viewer.email, role: "viewer" }, admin);
    expect((await post(`/api/shows/${source.id}/clone`, { name: "x" }, viewer.cookie)).status).toBe(
      403,
    );
    const stranger = await newUser(admin, "Stranger");
    expect(
      (await post(`/api/shows/${source.id}/clone`, { name: "x" }, stranger.cookie)).status,
    ).toBe(404);
    expect((await post(`/api/shows/${source.id}/clone`, { name: "" }, admin)).status).toBe(400);

    const res = await post(
      `/api/shows/${source.id}/clone`,
      { name: "My template", asTemplate: true },
      admin,
    );
    expect(res.status).toBe(201);
    const { show } = (await res.json()) as CloneShowResponse;
    expect(show).toMatchObject({ name: "My template", role: "owner", isTemplate: true });
    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie: admin })
    ).json()) as SnapshotResponse;
    expect(snap.meta.default_unit).toBe("ft-in");
    expect(snap.tables.surfaces.map((s) => s.name)).toEqual(["WALL", "WALL L"]);
    const [wall, wallL] = snap.tables.surfaces;
    expect(wallL?.parent_id).toBe(wall?.id);
    expect(wall?.id).not.toBe(surface);
    expect(snap.tables.scenes.map((s) => s.number)).toEqual(["101"]);
    const newScene = snap.tables.scenes[0]?.id ?? "";
    expect(snap.joins.sceneSurfaces[newScene]).toEqual([wall?.id]);
    expect(snap.tables.cues).toHaveLength(0);
    expect(snap.tables.shot_lists).toHaveLength(0);
    expect(snap.tables.custom_rows).toHaveLength(0);
    expect(snap.tables.custom_tables.map((t) => t.label)).toEqual(["Network"]);
    const newTable = snap.tables.custom_tables[0]?.id ?? "";
    expect(snap.tables.custom_fields.map((f) => [f.table, f.key])).toEqual(
      expect.arrayContaining([
        ["cues", "cam"],
        [customTableRef(newTable), "ip"],
      ]),
    );
    const byCam = snap.tables.views.find((v) => v.name === "By cam");
    // The view's scene filter follows the copied scene.
    expect(byCam?.config).toMatchObject({ filters: [{ key: "scene", value: newScene }] });
    // One set of cue views: the copies replaced the seeded default.
    expect(
      snap.tables.views
        .filter((v) => v.table === "cues")
        .map((v) => v.name)
        .sort(),
    ).toEqual(["All cues", "By cam"]);

    // Templates are flagged in the list; a show from the template without scenes.
    const list1 = (await (await api("/api/shows", { cookie: admin })).json()) as ShowsResponse;
    expect(list1.shows.find((s) => s.id === show.id)?.isTemplate).toBe(true);
    expect(list1.shows.find((s) => s.id === source.id)?.isTemplate).toBe(false);
    const res2 = await post(
      `/api/shows/${show.id}/clone`,
      { name: "New show", includeScenes: false },
      admin,
    );
    expect(res2.status).toBe(201);
    const second = (await res2.json()) as CloneShowResponse;
    expect(second.show.isTemplate).toBe(false);
    const snap2 = (await (
      await api(`/api/shows/${second.show.id}/snapshot`, { cookie: admin })
    ).json()) as SnapshotResponse;
    expect(snap2.tables.scenes).toHaveLength(0);
    expect(snap2.tables.surfaces).toHaveLength(2);
  });
});
