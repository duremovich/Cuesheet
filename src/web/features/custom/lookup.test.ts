// Lookup custom fields: a note's "Content (from cues)" (the WG case), through refs, reverse
// links and custom links, of selects, text, formulas and other lookups; formulas reading a
// lookup; error values for missing fields, cycles and sensitive fields; and the record
// columns kept in step with the tabs' own columns.
import { describe, expect, it } from "vitest";
import { newId } from "../../../shared/ids";
import { CORE_LINK_COLUMNS } from "../../../shared/lookup";
import type { CustomFieldRow, DataTableName } from "../../../shared/tables";
import { VIEW_FIELDS } from "../../../shared/views";
import type { Column, PickerItem } from "../../components/grid/types";
import { emptyData, type ShowData } from "../../lib/show-state";
import type { ShowStore } from "../../lib/show-store";
import { contentColumns } from "../content/columns";
import { cueColumns } from "../cues/columns";
import { tableRows } from "../export/exportAll";
import { exportCell } from "../export/exportView";
import { noteColumns } from "../notes/columns";
import { personColumns } from "../people/columns";
import { sceneColumns } from "../scenes/columns";
import { shotColumns } from "../shots/columns";
import { surfaceColumns } from "../surfaces/columns";
import { fieldKind } from "../views/evaluate";
import { customColumns } from "./columns";
import { lookupFieldColumns, lookupLinkColumns, lookupSummary, recordColumns } from "./lookup";

let seq = 0;
function field(
  table: string,
  key: string,
  type: CustomFieldRow["type"],
  options: CustomFieldRow["options"] = {},
  label = key,
): CustomFieldRow {
  return {
    id: `f${seq++}`,
    table,
    key,
    label,
    type,
    options,
    position: seq,
    width: null,
    custom: {},
    created_at: 0,
    created_by: "u",
    updated_at: 0,
    updated_by: "u",
  };
}

const row = <T>(fields: Record<string, unknown>): T => ({ custom: {}, ...fields }) as T;

/** Scene 101; content A, B, C; cues 1 (A, B), 2 (B, C), 3 (none); note n1 → cues 1, 2. */
function show(): ShowData {
  const d = emptyData();
  d.tables.scenes.set("s1", row({ id: "s1", number: "101", name: "Open" }));
  for (const [id, name] of [
    ["a", "101-001-A"],
    ["b", "101-002-B"],
    ["c", "101-003-C"],
  ] as const) {
    d.tables.content.set(id, row({ id, name, scene_id: "s1", status: null }));
    d.order.content.push(id);
  }
  d.tables.cues.set("q1", row({ id: "q1", number: "1", status: "Ready", scene_id: "s1" }));
  d.tables.cues.set("q2", row({ id: "q2", number: "2", status: "Draft", scene_id: "s1" }));
  d.tables.cues.set("q3", row({ id: "q3", number: "3", status: "Ready", scene_id: null }));
  d.order.cues.push("q1", "q2", "q3");
  d.joins.cueContent.set("q1", ["a", "b"]);
  d.joins.cueContent.set("q2", ["b", "c"]);
  d.tables.notes.set("n1", row({ id: "n1", body: "fix it" }));
  d.joins.noteCues.set("n1", ["q1", "q2"]);
  d.fieldOptions = {
    "cues.status": [
      { value: "Draft", color: "gray" },
      { value: "Ready", color: "green" },
    ],
  };
  return d;
}

/** Add field definitions (a new map, as the store makes: field lists are cached by it). */
function define(d: ShowData, ...fields: CustomFieldRow[]) {
  d.tables.custom_fields = new Map([
    ...d.tables.custom_fields,
    ...fields.map((f) => [f.id, f] as const),
  ]);
}

/** The notes tab's custom columns over raw notes, read for note `id`. */
function noteValue(d: ShowData, key: string, id = "n1") {
  const store = { getState: () => d } as unknown as ShowStore;
  const defs = [...d.tables.custom_fields.values()].filter((f) => f.table === "notes");
  const cols = customColumns<{ id: string; custom: Record<string, never> }>(defs, {
    store,
    table: "notes",
    rowOf: (r) => r,
    editable: true,
    showId: "s",
    baseColumns: [],
    sampleRows: [...d.tables.notes.values()] as never[],
  });
  const col = cols.find((c) => c.key === `custom.${key}`);
  if (!col) throw new Error(`no column ${key}`);
  return { col, value: col.getValue(d.tables.notes.get(id) as never) };
}

/** Set a cue's custom values. */
function setCustom(d: ShowData, id: string, custom: Record<string, string | string[]>) {
  const cue = d.tables.cues.get(id);
  if (cue) d.tables.cues.set(id, { ...cue, custom });
}

const labels = (v: unknown) => (v as PickerItem[]).map((p) => p.label);

describe("lookup fields", () => {
  it("a note's content through its cues: chips, deduped, in link order, live", () => {
    const d = show();
    define(d, field("notes", "cue_content", "lookup", { link: "cues", field: "content" }));
    const { col, value } = noteValue(d, "cue_content");
    expect(col.type).toBe("multilink");
    expect(col.editable).toBe(false);
    expect(labels(value)).toEqual(["101-001-A", "101-002-B", "101-003-C"]);
    expect((value as PickerItem[])[0]).toMatchObject({ id: "a", secondary: "101 Open" });

    // The cue's content changes (a new state object, as the store makes): the note follows.
    const next = { ...d, joins: { ...d.joins, cueContent: new Map(d.joins.cueContent) } };
    next.joins.cueContent.set("q2", ["c"]);
    next.joins.cueContent.set("q1", []);
    expect(labels(noteValue(next, "cue_content").value)).toEqual(["101-003-C"]);
    // No cues → no chips.
    next.tables.notes.set("n2", row({ id: "n2" }));
    expect(noteValue(next, "cue_content", "n2").value).toEqual([]);
  });

  it("selects keep their colors; text values are one value or a list", () => {
    const d = show();
    define(
      d,
      field("notes", "cue_status", "lookup", { link: "cues", field: "status" }),
      field("notes", "cue_number", "lookup", { link: "cues", field: "number" }),
      field("notes", "scene_names", "lookup", { link: "content", field: "scene" }),
    );
    const status = noteValue(d, "cue_status");
    expect(status.col.type).toBe("multiselect");
    expect(status.col.options).toEqual([
      { value: "Draft", color: "gray" },
      { value: "Ready", color: "green" },
    ]);
    expect(status.value).toEqual(["Ready", "Draft"]);

    const numbers = noteValue(d, "cue_number");
    expect(numbers.col.type).toBe("formula");
    expect(numbers.value).toEqual(["1", "2"]);
    d.joins.noteCues.set("n1", ["q2"]);
    expect(noteValue(d, "cue_number").value).toBe("2");
    d.joins.noteCues.set("n1", []);
    expect(noteValue(d, "cue_number").value).toBeNull();
  });

  it("through a single reference, a reverse link and a custom link to a custom table", () => {
    const d = show();
    // Content → its cues (the reverse side of cues.content) → their numbers.
    const t1 = newId();
    d.tables.custom_tables.set(t1, row({ id: t1, label: "Venues", primary_field_key: "name" }));
    d.tables.custom_rows.set(
      "v1",
      row({ id: "v1", table_id: t1, custom: { name: "Olney", city: "Olney MD" } }),
    );
    d.order.custom_rows.push("v1");
    define(
      d,
      field(`custom:${t1}`, "name", "text", {}, "Name"),
      field(`custom:${t1}`, "city", "text", {}, "City"),
      field("content", "cue_numbers", "lookup", { link: "cues", field: "number" }),
      field("cues", "scene_name", "lookup", { link: "scene", field: "name" }),
      field("cues", "venue", "link", { target: `custom:${t1}` }, "Venue"),
      field("cues", "venue_city", "lookup", { link: "custom.venue", field: "custom.city" }),
    );
    setCustom(d, "q1", { venue: ["v1"] });
    const content = recordColumns(d, "content").get("custom.cue_numbers");
    expect(content?.getValue(d.tables.content.get("b") as never)).toEqual(["1", "2"]);
    const cues = recordColumns(d, "cues");
    expect(cues.get("custom.scene_name")?.getValue(d.tables.cues.get("q1") as never)).toBe("Open");
    expect(cues.get("custom.scene_name")?.getValue(d.tables.cues.get("q3") as never)).toBeNull();
    expect(cues.get("custom.venue_city")?.getValue(d.tables.cues.get("q1") as never)).toBe(
      "Olney MD",
    );
  });

  it("a lookup of a lookup, of a formula; formulas read lookups", () => {
    const d = show();
    define(
      d,
      // cues: the scene of each linked content (a lookup), and a formula.
      field(
        "cues",
        "content_scene",
        "lookup",
        { link: "content", field: "scene" },
        "Content scene",
      ),
      field("cues", "loud", "formula", { formula: '{Cue} & "!"' }, "Loud"),
      // notes: lookups of those, and formulas over the WG lookup.
      field("notes", "scenes", "lookup", { link: "cues", field: "custom.content_scene" }),
      field("notes", "louds", "lookup", { link: "cues", field: "custom.loud" }),
      field("notes", "cue_content", "lookup", { link: "cues", field: "content" }, "Cue content"),
      field("notes", "n_content", "formula", { formula: "COUNT({Cue content})" }),
      field("notes", "names", "formula", { formula: 'JOIN({Cue content}.Name, " / ")' }),
    );
    const scenes = noteValue(d, "scenes");
    expect(scenes.col.type).toBe("multilink");
    expect(labels(scenes.value)).toEqual(["101 Open"]);
    expect(noteValue(d, "louds").value).toEqual(["1!", "2!"]);
    expect(noteValue(d, "n_content").value).toBe(3);
    expect(noteValue(d, "names").value).toBe("101-001-A / 101-002-B / 101-003-C");
    expect(lookupSummary(d, [...d.tables.custom_fields.values()][2] as CustomFieldRow)).toBe(
      "Cues → Content scene",
    );
  });

  it("missing fields are #NAME, cycles #ERROR (never a hang), sensitive fields #HIDDEN", () => {
    const d = show();
    define(
      d,
      field("notes", "no_link", "lookup", { link: "custom.gone", field: "number" }),
      field("notes", "no_field", "lookup", { link: "cues", field: "nope" }),
      field("notes", "loop_a", "lookup", { link: "cues", field: "custom.loop_b" }),
      field("cues", "loop_b", "lookup", { link: "notes_of", field: "custom.loop_a" }),
      field("cues", "secret", "text", { sensitive: true }),
      field("notes", "leak", "lookup", { link: "cues", field: "custom.secret" }),
      // A cycle through a formula: notes.f reads notes.via, which shows cues.g, which
      // shows notes.f again through a custom link back to notes.
      field("cues", "back", "link", { target: "notes" }),
      field("notes", "f", "formula", { formula: "{via}" }),
      field("notes", "via", "lookup", { link: "cues", field: "custom.g" }),
      field("cues", "g", "lookup", { link: "custom.back", field: "custom.f" }),
    );
    setCustom(d, "q1", { back: ["n1"], secret: "pw" });
    expect(noteValue(d, "no_link").value).toMatchObject({ code: "#NAME" });
    expect(noteValue(d, "no_field").value).toMatchObject({ code: "#NAME" });
    // loop_b's link doesn't exist, so loop_a fails on it (a #NAME, not a hang).
    expect(noteValue(d, "loop_a").value).toMatchObject({ code: "#NAME" });
    expect(noteValue(d, "leak").value).toMatchObject({ code: "#HIDDEN" });
    expect(noteValue(d, "via").value).toMatchObject({ code: "#ERROR" });
    expect(noteValue(d, "f").value).toMatchObject({ code: "#ERROR" });

    // A lookup chain that comes back to itself.
    define(
      d,
      field("notes", "x", "lookup", { link: "cues", field: "custom.y" }),
      field("cues", "y", "lookup", { link: "custom.back", field: "custom.x" }),
    );
    expect(noteValue(d, "x").value).toMatchObject({ code: "#ERROR", error: /circular/ });
  });

  it("export: as the grid shows it, in a view's CSV and in Export all", () => {
    const d = show();
    define(
      d,
      field("notes", "cue_content", "lookup", { link: "cues", field: "content" }, "Cue content"),
      field("notes", "cue_number", "lookup", { link: "cues", field: "number" }, "Cue number"),
    );
    const content = noteValue(d, "cue_content");
    const n1 = d.tables.notes.get("n1") as never;
    expect(exportCell(content.col, n1)).toBe("101-001-A, 101-002-B, 101-003-C");
    expect(exportCell(noteValue(d, "cue_number").col, n1)).toBe("1, 2");
    const [header, first] = tableRows(d, "notes", "notes", [...d.tables.notes.values()]);
    const at = header?.indexOf("Cue content") ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(first?.[at]).toBe("101-001-A, 101-002-B, 101-003-C");
  });

  it("the Fields manager's choices: link fields of the table, fields of the linked table", () => {
    const d = show();
    define(d, field("notes", "venue", "link", { target: "persons" }, "Venue"));
    expect(lookupLinkColumns(d, "notes")).toEqual([
      { key: "assignees", title: "Assignees", target: "persons" },
      { key: "cues", title: "Cues", target: "cues" },
      { key: "content", title: "Content", target: "content" },
      { key: "scene", title: "Scene", target: "scenes" },
      { key: "custom.venue", title: "Venue", target: "persons" },
    ]);
    expect(lookupFieldColumns(d, "cues").map((c) => c.key)).toContain("content");
  });
});

// The record columns stand in for the tabs' columns: same keys, titles and kinds.
const store = {} as ShowStore;
const tabColumns: Record<DataTableName, Column<never>[]> = {
  cues: cueColumns({ store, fieldOptions: {}, editable: true }) as Column<never>[],
  notes: noteColumns({ store, fieldOptions: {}, canCreateRecords: true }) as Column<never>[],
  content: contentColumns({ store, fieldOptions: {}, editable: true }) as Column<never>[],
  scenes: sceneColumns({}, true, store) as Column<never>[],
  persons: personColumns({}, true) as Column<never>[],
  surfaces: surfaceColumns({ store, editable: true }) as Column<never>[],
  shots: shotColumns({ store, fieldOptions: {}, editable: true, showId: "s" }) as Column<never>[],
};

describe("record columns match the tabs' columns", () => {
  for (const table of Object.keys(tabColumns) as DataTableName[]) {
    it(table, () => {
      const records = [...recordColumns(emptyData(), table).values()];
      const tab = new Map(tabColumns[table].map((c) => [c.key, c]));
      for (const c of records) {
        const t = tab.get(c.key);
        expect(t, `${table}.${c.key} is a tab column`).toBeDefined();
        expect(c.title).toBe(t?.title);
        expect(fieldKind(c)).toBe(VIEW_FIELDS[table][c.key]?.kind);
      }
      // Every link-like column is one a lookup can go through, and vice versa.
      const links = records
        .filter((c) => c.type === "link" || c.type === "multilink")
        .map((c) => c.key)
        .sort();
      expect(links).toEqual(Object.keys(CORE_LINK_COLUMNS[table] ?? {}).sort());
      // Only files and a few counts are missing.
      const missing = [...tab.keys()].filter((k) => !records.some((c) => c.key === k));
      for (const k of missing) {
        expect(["readonly", "attachment"]).toContain(tab.get(k)?.type);
      }
    });
  }
});
