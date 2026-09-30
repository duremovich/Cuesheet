// The optimistic mirror of the op engine's custom field rules (values cleared when a field
// is deleted or retyped, links following deleted records, a custom table taking its fields,
// views and link fields with it), and the "Export all tables" CSVs built from the state.
// test/worker/custom-fields.test.ts covers the server.
import { describe, expect, it } from "vitest";
import { newId } from "../../shared/ids";
import type { ResolvedOp } from "../../shared/ops";
import { exportAllTables } from "../features/export/exportAll";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "./show-state";

const T1 = newId();
const ctx = { userId: "u", now: 1000 };
const common = { custom: {}, created_at: 1, created_by: "u", updated_at: 1, updated_by: "u" };
const fieldRow = (id: string, table: string, key: string, type: string, options = {}) => ({
  op: "create" as const,
  table: "custom_fields" as const,
  id,
  fields: { ...common, table, key, label: key, type, options, position: 1, width: null },
});

function seed(): ShowData {
  const ops: ResolvedOp[] = [
    { op: "create", table: "persons", id: "p1", fields: { ...common, name: "Casey" } },
    { op: "create", table: "persons", id: "p2", fields: { ...common, name: "Riley" } },
    {
      op: "create",
      table: "custom_tables",
      id: T1,
      fields: {
        ...common,
        label: "Network",
        key: "network",
        position: 1,
        primary_field_key: "name",
      },
    },
    fieldRow("f1", "cues", "who", "link", { target: "persons" }),
    fieldRow("f2", "cues", "note", "text"),
    fieldRow("f3", `custom:${T1}`, "name", "text"),
    fieldRow("f4", `custom:${T1}`, "password", "text", { sensitive: true }),
    fieldRow("f5", "cues", "device", "link", { target: `custom:${T1}` }),
    {
      op: "create",
      table: "custom_rows",
      id: "r1",
      fields: { ...common, table_id: T1, order_key: "a0", custom: { name: "Mac", password: "pw" } },
    },
    {
      op: "create",
      table: "cues",
      id: "c1",
      fields: {
        ...common,
        number: "1",
        order_key: "a0",
        is_section: false,
        custom: { who: ["p1", "p2"], note: "hello", device: ["r1"] },
      },
    },
    {
      op: "create",
      table: "views",
      id: "v1",
      fields: { ...common, table: `custom:${T1}`, name: "All rows", owner_user_id: null },
    },
  ];
  return applyResolved(emptyData(), ops);
}

const apply = (data: ShowData, ops: Parameters<typeof resolveLocal>[1]) => {
  const resolved = resolveLocal(data, ops, ctx);
  return { resolved, data: applyResolved(data, resolved) };
};

describe("custom fields: optimistic cascades", () => {
  it("a deleted person leaves link values; a deleted field leaves every row", () => {
    let { data } = apply(seed(), [{ op: "delete", table: "persons", id: "p1" }]);
    expect(data.tables.cues.get("c1")?.custom.who).toEqual(["p2"]);
    ({ data } = apply(data, [{ op: "delete", table: "custom_fields", id: "f2" }]));
    expect(data.tables.cues.get("c1")?.custom).not.toHaveProperty("note");
  });

  it("a type change clears values that don't fit", () => {
    const { data, resolved } = apply(seed(), [
      { op: "update", table: "custom_fields", id: "f2", fields: { type: "number" } },
    ]);
    expect(data.tables.cues.get("c1")?.custom).not.toHaveProperty("note");
    expect(resolved.some((o) => o.op === "update" && o.table === "cues")).toBe(true);
  });

  it("a deleted custom table takes its rows, fields, views and the links into it", () => {
    const { data } = apply(seed(), [{ op: "delete", table: "custom_tables", id: T1 }]);
    expect(data.tables.custom_rows.size).toBe(0);
    expect([...data.tables.custom_fields.keys()].sort()).toEqual(["f1", "f2"]);
    expect(data.tables.views.size).toBe(0);
    expect(data.tables.cues.get("c1")?.custom).not.toHaveProperty("device");
  });
});

describe("export all tables", () => {
  it("one table per core and custom table; links as labels; sensitive left out", () => {
    const tables = exportAllTables(seed());
    const cues = tables.find((t) => t.table === "cues");
    expect(cues?.file).toBe("Cues.csv");
    const [header, row] = cues?.rows ?? [];
    expect(header?.[0]).toBe("id");
    expect(row?.[header?.indexOf("who") ?? -1]).toBe("Casey, Riley");
    expect(row?.[header?.indexOf("device") ?? -1]).toBe("Mac");
    const net = tables.find((t) => t.label === "Network");
    expect(net?.file).toBe("Network.csv");
    expect(net?.rows[0]).toEqual(["id", "name"]);
    expect(net?.rows[1]).toEqual(["r1", "Mac"]);
    const withSecret = exportAllTables(seed(), { includeSensitive: true }).find(
      (t) => t.label === "Network",
    );
    expect(withSecret?.rows[1]).toEqual(["r1", "Mac", "pw"]);
  });
});
