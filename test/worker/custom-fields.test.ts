// M5a: custom fields (every type, link targets, attachment fields, sensitive values),
// custom tables (ops, views, history, snapshot, cascades) and the import of the other
// Airtable CSVs into custom tables.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import networkCsv from "../../examples/Network-Grid view.csv?raw";
import personnelCsv from "../../examples/Personnel-Grid view.csv?raw";
import referenceCsv from "../../examples/Reference Links-Grid view.csv?raw";
import type { Role } from "../../src/shared/api";
import { customTableRef } from "../../src/shared/custom-fields";
import { newId } from "../../src/shared/ids";
import type {
  AnyOp,
  HistoryResponse,
  ImportResponse,
  SnapshotResponse,
} from "../../src/shared/ops";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import { HIDDEN_VALUE } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";
import { api, createShow, loginAdmin, ORIGIN, post } from "./helpers";

let seq = 0;
async function freshShow() {
  const name = `custom-${Date.now()}-${seq++}`;
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

const field = (
  table: string,
  key: string,
  type: string,
  options: Record<string, unknown> = {},
  id = newId(),
): AnyOp => ({
  op: "create",
  table: "custom_fields",
  id,
  fields: { table, key, label: key.replace(/_/g, " "), type, options },
});

const setCustom = (table: "cues" | "custom_rows" | "shots", id: string, custom: object): AnyOp => ({
  op: "update",
  table,
  id,
  fields: { custom },
});

describe("custom fields: definitions", () => {
  it("creates, renames, reorders and refuses bad definitions", async () => {
    const stub = await freshShow();
    const id = newId();
    ok(await stub.mutate(ctx(), [field("cues", "camera_move", "text", {}, id)]));
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "custom_fields", id, fields: { label: "Camera", position: 3 } },
      ]),
    );
    const snap = await snapshot(stub);
    expect(snap.tables.custom_fields).toMatchObject([
      { id, table: "cues", key: "camera_move", label: "Camera", type: "text", position: 3 },
    ]);
    // Same key on the same table; bad key; unknown table / type; key can't change.
    expect(fail(await stub.mutate(ctx(), [field("cues", "camera_move", "text")])).error).toMatch(
      /already has a field/,
    );
    ok(await stub.mutate(ctx(), [field("scenes", "camera_move", "text")]));
    fail(await stub.mutate(ctx(), [field("cues", "Bad Key", "text")]));
    fail(await stub.mutate(ctx(), [field("views", "x", "text")]));
    fail(await stub.mutate(ctx(), [field("cues", "y", "rainbow")]));
    fail(await stub.mutate(ctx(), [field("cues", "z", "link", { target: "nowhere" })]));
    fail(await stub.mutate(ctx(), [field("cues", "f", "formula", {})]));
    fail(
      await stub.mutate(ctx(), [
        { op: "update", table: "custom_fields", id, fields: { key: "other" } },
      ]),
    );
  });

  it("is for editors and owners only", async () => {
    const stub = await freshShow();
    for (const role of ["commenter", "viewer"] as const) {
      expect(
        fail(await stub.mutate(ctx(role, `u-${role}`), [field("cues", "x", "text")])).status,
      ).toBe(403);
    }
    ok(await stub.mutate(ctx("owner", "u-owner"), [field("cues", "x", "text")]));
  });
});

describe("custom fields: values", () => {
  it("validates every stored type", async () => {
    const stub = await freshShow();
    const cue = newId();
    const person = newId();
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "cues", id: cue, fields: { number: "1" } },
        { op: "create", table: "persons", id: person, fields: { name: "Casey" } },
        field("cues", "t", "text"),
        field("cues", "lt", "longtext"),
        field("cues", "n", "number"),
        field("cues", "cb", "checkbox"),
        field("cues", "sel", "select", { choices: [{ value: "A", color: "red" }, { value: "B" }] }),
        field("cues", "ms", "multiselect", { choices: [{ value: "A" }, { value: "B" }] }),
        field("cues", "d", "date"),
        field("cues", "dt", "datetime"),
        field("cues", "dur", "duration"),
        field("cues", "tc", "timecode"),
        field("cues", "len", "measurement"),
        field("cues", "px", "pixel_size"),
        field("cues", "u", "url"),
        field("cues", "who", "link", { target: "persons" }),
        field("cues", "one", "link", { target: "persons", multiple: false }),
        field("cues", "files", "attachment"),
        field("cues", "calc", "formula", { formula: "{n} * 2" }),
      ]),
    );
    const good = {
      t: "hello",
      lt: "line 1\nline 2",
      n: 4.5,
      cb: true,
      sel: "A",
      ms: ["B", "A"],
      d: "2026-09-30",
      dt: "2026-09-30T19:30",
      dur: "0:01:30.5",
      tc: "01:00:10:12",
      len: 4.5,
      px: { w: 1920, h: 1080 },
      u: "https://example.com/x",
      who: [person],
      one: [person],
    };
    ok(await stub.mutate(ctx(), [setCustom("cues", cue, good)]));
    const snap = await snapshot(stub);
    expect(snap.tables.cues[0]?.custom).toEqual(good);
    // Default select color is gray.
    const sel = snap.tables.custom_fields.find((f) => f.key === "sel");
    expect(sel?.options.choices).toEqual([
      { value: "A", color: "red" },
      { value: "B", color: "gray" },
    ]);

    const bad: Record<string, unknown> = {
      t: 5,
      n: "4",
      cb: "yes",
      sel: "C",
      ms: ["A", "A"],
      d: "2026-02-30",
      dt: "2026-09-30 19:30",
      dur: "90 s",
      tc: "01:00:10",
      len: -1,
      px: { w: 0, h: 5 },
      u: "not a url",
      who: [newId()],
      one: [person, person],
      files: ["x"],
      calc: 3,
    };
    for (const [k, v] of Object.entries(bad)) {
      const r = fail(await stub.mutate(ctx(), [setCustom("cues", cue, { [k]: v })]));
      expect(r.error, k).toMatch(new RegExp(`custom\\.${k}`));
    }
    // null clears; keys without a definition stay free-form.
    ok(await stub.mutate(ctx(), [setCustom("cues", cue, { t: null, note_from_import: "x" })]));
    const after = (await snapshot(stub)).tables.cues[0]?.custom;
    expect(after?.t).toBeUndefined();
    expect(after?.note_from_import).toBe("x");
  });

  it("clears values when a field is deleted, retyped or loses a choice; links follow deletes", async () => {
    const stub = await freshShow();
    const [cue, p1, p2] = [newId(), newId(), newId()];
    const [fText, fSel, fLink] = [newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "persons", id: p1, fields: { name: "A" } },
        { op: "create", table: "persons", id: p2, fields: { name: "B" } },
        { op: "create", table: "cues", id: cue, fields: {} },
        field("cues", "t", "text", {}, fText),
        field("cues", "sel", "multiselect", { choices: [{ value: "A" }, { value: "B" }] }, fSel),
        field("cues", "who", "link", { target: "persons" }, fLink),
        setCustom("cues", cue, { t: "x", sel: ["A", "B"], who: [p1, p2] }),
      ]),
    );
    // Text → long text keeps; a removed choice leaves; a deleted person leaves the link.
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "custom_fields", id: fText, fields: { type: "longtext" } },
        {
          op: "update",
          table: "custom_fields",
          id: fSel,
          fields: { options: { choices: [{ value: "B" }] } },
        },
        { op: "delete", table: "persons", id: p1 },
      ]),
    );
    expect((await snapshot(stub)).tables.cues[0]?.custom).toEqual({
      t: "x",
      sel: ["B"],
      who: [p2],
    });
    // Long text → number clears; deleting the link field clears it.
    const r = ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "custom_fields", id: fText, fields: { type: "number" } },
        { op: "delete", table: "custom_fields", id: fLink },
      ]),
    );
    expect((await snapshot(stub)).tables.cues[0]?.custom).toEqual({ sel: ["B"] });
    // The cascades are explicit ops (clients replay them).
    expect(r.ops.filter((o) => o.op === "update" && o.table === "cues")).toHaveLength(2);
  });

  it("keeps sensitive values out of history", async () => {
    const stub = await freshShow();
    const cue = newId();
    ok(
      await stub.mutate(ctx(), [
        field("cues", "password", "text", { sensitive: true }),
        { op: "create", table: "cues", id: cue, fields: { custom: { password: "hunter2" } } },
      ]),
    );
    ok(await stub.mutate(ctx(), [setCustom("cues", cue, { password: "correct horse" })]));
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "cues", id: cue }]));
    const history = await stub.history({ table: "cues", id: cue });
    const text = JSON.stringify(history);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("correct horse");
    expect(history.find((h) => h.field === "custom.password")).toMatchObject({
      old: JSON.stringify(HIDDEN_VALUE),
      new: JSON.stringify(HIDDEN_VALUE),
    });
    // The value itself is stored (members can reveal it).
  });

  it("attachment custom fields: upload, then files go with the field", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "custom-files");
    const cue = newId();
    const fieldId = newId();
    const m = await post(
      `/api/shows/${show.id}/mutate`,
      {
        clientId: "c",
        ops: [
          { op: "create", table: "cues", id: cue, fields: { number: "1" } },
          field("cues", "storyboard", "attachment", {}, fieldId),
        ],
      },
      admin,
    );
    expect(m.status).toBe(200);
    const bad = await post(
      `/api/shows/${show.id}/attachments/upload-url`,
      {
        table: "cues",
        recordId: cue,
        field: "nope",
        filename: "a.png",
        contentType: "image/png",
        size: 3,
      },
      admin,
    );
    expect(bad.status).toBe(400);
    const res = await post(
      `/api/shows/${show.id}/attachments/upload-url`,
      {
        table: "cues",
        recordId: cue,
        field: "storyboard",
        filename: "board.txt",
        contentType: "text/plain",
        size: 3,
      },
      admin,
    );
    expect(res.status).toBe(200);
    const { uploadUrl } = (await res.json()) as { uploadUrl: string };
    const put = await api(uploadUrl, {
      method: "PUT",
      body: new TextEncoder().encode("abc"),
      headers: { "Content-Type": "text/plain" },
      cookie: admin,
    });
    expect(put.status, await put.clone().text()).toBe(201);
    const stub = env.SHOW.get(env.SHOW.idFromName(show.id));
    let snap = await snapshot(stub);
    expect(snap.tables.attachments).toMatchObject([
      { table: "cues", record_id: cue, field: "storyboard" },
    ]);
    ok(
      await stub.mutate(ctx("owner", "u"), [{ op: "delete", table: "custom_fields", id: fieldId }]),
    );
    snap = await snapshot(stub);
    expect(snap.tables.attachments).toHaveLength(0);
  });
});

describe("custom tables", () => {
  it("rows, links between custom tables, views, history and cascades", async () => {
    const stub = await freshShow();
    const [net, gear] = [newId(), newId()];
    const [r1, r2, g1] = [newId(), newId(), newId()];
    const view = newId();
    ok(
      await stub.mutate(ctx(), [
        {
          op: "create",
          table: "custom_tables",
          id: net,
          fields: { label: "Network", position: 1 },
        },
        { op: "create", table: "custom_tables", id: gear, fields: { label: "Gear", position: 2 } },
        field(customTableRef(net), "name", "text"),
        field(customTableRef(net), "ip", "text"),
        field(customTableRef(gear), "device", "text"),
        field(customTableRef(gear), "network", "link", { target: customTableRef(net) }),
        {
          op: "create",
          table: "views",
          id: view,
          fields: { table: customTableRef(net), name: "All rows", is_default: true },
        },
        {
          op: "create",
          table: "custom_rows",
          id: r1,
          fields: { table_id: net, custom: { name: "Mac" } },
        },
        {
          op: "create",
          table: "custom_rows",
          id: r2,
          fields: { table_id: net, custom: { name: "LED" } },
        },
        {
          op: "create",
          table: "custom_rows",
          id: g1,
          fields: { table_id: gear, custom: { device: "Switch", network: [r1, r2] } },
        },
      ]),
    );
    ok(await stub.mutate(ctx(), [{ op: "move", table: "custom_rows", id: r2, before: r1 }]));
    // A link must point into its target table.
    fail(await stub.mutate(ctx(), [setCustom("custom_rows", g1, { network: [g1] })]));
    // A view config may use the table's custom fields (and nothing else).
    ok(
      await stub.mutate(ctx(), [
        {
          op: "update",
          table: "views",
          id: view,
          fields: {
            config: {
              filters: [{ key: "custom.ip", op: "contains", value: "192" }],
              filterMode: "and",
              sorts: [{ key: "custom.name", dir: "asc" }],
              sortMode: "live",
              group: { key: null },
              fields: [],
              rowHeight: "normal",
              frozenCount: 1,
              colorRules: [],
            },
          },
        },
      ]),
    );
    fail(
      await stub.mutate(ctx(), [
        {
          op: "update",
          table: "views",
          id: view,
          fields: {
            config: {
              filters: [{ key: "number", op: "contains", value: "1" }],
              filterMode: "and",
              sorts: [],
              sortMode: "none",
              group: { key: null },
              fields: [],
              rowHeight: "normal",
              frozenCount: 1,
              colorRules: [],
            },
          },
        },
      ]),
    );
    let snap = await snapshot(stub);
    expect(snap.tables.custom_rows.filter((r) => r.table_id === net).map((r) => r.id)).toEqual([
      r2,
      r1,
    ]);
    const history = await stub.history({ table: "custom_rows", id: g1 });
    expect(history.some((h) => h.field === "*")).toBe(true);

    // Deleting a row leaves the links; deleting the table takes its rows, fields, views and
    // the link field pointing at it.
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "custom_rows", id: r1 }]));
    snap = await snapshot(stub);
    expect(snap.tables.custom_rows.find((r) => r.id === g1)?.custom.network).toEqual([r2]);
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "custom_tables", id: net }]));
    snap = await snapshot(stub);
    expect(snap.tables.custom_rows.map((r) => r.id)).toEqual([g1]);
    expect(snap.tables.custom_rows[0]?.custom).toEqual({ device: "Switch" });
    expect(snap.tables.custom_fields.map((f) => f.key)).toEqual(["device"]);
    expect(snap.tables.views.some((v) => v.table === customTableRef(net))).toBe(false);
  });

  it("a deleted custom field leaves the views that used it", async () => {
    const stub = await freshShow();
    const [t, f, v] = [newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "custom_tables", id: t, fields: { label: "Calendar" } },
        field(customTableRef(t), "status", "select", { choices: [{ value: "Done" }] }, f),
        {
          op: "create",
          table: "views",
          id: v,
          fields: {
            table: customTableRef(t),
            name: "Done",
            config: {
              filters: [{ key: "custom.status", op: "is", value: "Done" }],
              filterMode: "and",
              sorts: [],
              sortMode: "none",
              group: { key: "custom.status" },
              fields: [{ key: "custom.status", width: 120 }],
              rowHeight: "normal",
              frozenCount: 1,
              colorRules: [],
            },
          },
        },
        { op: "delete", table: "custom_fields", id: f },
        // Saving the view again drops the stale references instead of failing.
        {
          op: "update",
          table: "views",
          id: v,
          fields: {
            config: {
              filters: [{ key: "custom.status", op: "is", value: "Done" }],
              filterMode: "and",
              sorts: [],
              sortMode: "none",
              group: { key: "custom.status" },
              fields: [{ key: "custom.status" }],
              rowHeight: "tall",
              frozenCount: 1,
              colorRules: [],
            },
          },
        },
      ]),
    );
    const view = (await snapshot(stub)).tables.views.find((x) => x.id === v);
    expect(view?.config).toMatchObject({
      filters: [],
      group: { key: null },
      fields: [],
      rowHeight: "tall",
    });
  });

  it("views can't name a custom table that doesn't exist", async () => {
    const stub = await freshShow();
    fail(
      await stub.mutate(ctx(), [
        {
          op: "create",
          table: "views",
          id: newId(),
          fields: { table: customTableRef(newId()), name: "x" },
        },
      ]),
    );
  });
});

describe("import: other CSVs become custom tables", () => {
  it("types guessed, sensitive passwords, unmapped core columns as custom fields", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "import-custom");
    const personnel = `${personnelCsv.trimEnd().split("\n")[0]},Shirt size\r\nAlex Doe,Actor,alex@example.com,,Example Theatre,checked,,,M\r\n`;
    const form = new FormData();
    form.append("files", new File([networkCsv], "Network-Grid view.csv", { type: "text/csv" }));
    form.append(
      "files",
      new File([referenceCsv], "Reference Links-Grid view.csv", { type: "text/csv" }),
    );
    form.append("files", new File([personnel], "Personnel-Grid view.csv", { type: "text/csv" }));
    form.append(
      "mapping",
      JSON.stringify({
        columns: [
          {
            file: "Personnel-Grid view.csv",
            column: "Shirt size",
            label: "Shirt size",
            type: "select",
          },
        ],
        tables: [{ file: "Reference Links-Grid view.csv", label: "Links" }],
      }),
    );
    const res = await api(`/api/shows/${show.id}/import/airtable`, {
      method: "POST",
      body: form,
      cookie: admin,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResponse;
    expect(body.created.custom_tables).toBe(2);
    expect(body.created.persons).toBe(1);
    const stub = env.SHOW.get(env.SHOW.idFromName(show.id));
    const snap = await snapshot(stub);
    const tables = snap.tables.custom_tables.map((t) => t.label);
    expect(tables).toEqual(["Network", "Links"]);
    const network = snap.tables.custom_tables.find((t) => t.label === "Network");
    const ref = customTableRef(network?.id ?? "");
    const fields = Object.fromEntries(
      snap.tables.custom_fields.filter((f) => f.table === ref).map((f) => [f.key, f]),
    );
    expect(fields.ip?.type).toBe("text");
    expect(fields.password).toMatchObject({ type: "text", options: { sensitive: true } });
    expect(fields.type?.type).toBe("select");
    expect(network?.primary_field_key).toBe("name");
    const rows = snap.tables.custom_rows.filter((r) => r.table_id === network?.id);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]?.custom).toMatchObject({ name: "Novastar LED Processor", ip: "192.168.11.163" });
    // A default view for each custom table.
    expect(snap.tables.views.filter((v) => v.table === ref)).toHaveLength(1);
    // Reference links: URL and checkbox columns.
    const links = snap.tables.custom_tables.find((t) => t.label === "Links");
    const linkFields = snap.tables.custom_fields.filter(
      (f) => f.table === customTableRef(links?.id ?? ""),
    );
    expect(linkFields.find((f) => f.key === "notes")?.type).toBe("url");
    expect(linkFields.find((f) => f.key === "pin")?.type).toBe("checkbox");
    // Personnel's extra column became a select custom field with a value.
    const shirt = snap.tables.custom_fields.find((f) => f.table === "persons");
    expect(shirt).toMatchObject({ key: "shirt_size", type: "select" });
    expect(snap.tables.persons[0]?.custom).toMatchObject({ shirt_size: "M" });
    // Passwords never reach the history.
    const history = (await (
      await api(`/api/shows/${show.id}/history?table=custom_rows&limit=1000`, { cookie: admin })
    ).json()) as HistoryResponse;
    expect(JSON.stringify(history)).not.toContain("REDACTED");
  });
});
