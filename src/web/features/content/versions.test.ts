import { describe, expect, it } from "vitest";
import type { ContentVersionRow, PersonRow } from "../../../shared/tables";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "../../lib/show-state";
import {
  addVersionOps,
  currentVersionLabel,
  currentVersions,
  nextVersionLabel,
  restoreVersionOps,
  today,
  versionsOf,
} from "./versions";

let seq = 0;
function version(fields: Partial<ContentVersionRow>): ContentVersionRow {
  seq++;
  return {
    id: `v${seq}`,
    custom: {},
    created_at: seq,
    created_by: "u",
    updated_at: seq,
    updated_by: "u",
    content_id: "c1",
    version: null,
    date: null,
    rendered_by: null,
    changes: null,
    file_path: null,
    is_current: false,
    status: null,
    position: seq,
    ...fields,
  };
}

const map = (rows: ContentVersionRow[]) => new Map(rows.map((r) => [r.id, r]));

describe("content versions (client)", () => {
  it("current version per content item, cached per map", () => {
    const a = version({ version: "V01" });
    const b = version({ version: "V02", is_current: true });
    const c = version({ content_id: "c2", version: "V05", is_current: true });
    const versions = map([a, b, c]);
    const cur = currentVersions(versions);
    expect(cur.get("c1")).toBe(b);
    expect(cur.get("c2")).toBe(c);
    expect(currentVersions(versions)).toBe(cur); // same map → same result
    expect(currentVersionLabel(versions, "c1")).toBe("V02");
    expect(currentVersionLabel(versions, "nope")).toBeNull();
    expect(currentVersions(new Map(versions))).not.toBe(cur);
  });

  it("lists a content item's versions newest first", () => {
    const a = version({ version: "V01", position: 1 });
    const b = version({ version: "V03", position: 3 });
    const c = version({ version: "V02", position: 2 });
    const other = version({ content_id: "c9", position: 9 });
    expect(versionsOf(map([a, b, c, other]), "c1").map((v) => v.version)).toEqual([
      "V03",
      "V02",
      "V01",
    ]);
  });

  it("suggests the next Vnn", () => {
    expect(nextVersionLabel([])).toBe("V01");
    expect(nextVersionLabel(["V02"])).toBe("V03");
    expect(nextVersionLabel(["V09a", "v03", null, "final"])).toBe("V10");
    expect(nextVersionLabel(["V99"])).toBe("V100");
  });

  it("formats today as YYYY-MM-DD (local)", () => {
    expect(today(new Date(2026, 8, 3, 23, 30))).toBe("2026-09-03");
  });

  it("Add version: next label, today, you (when you're a person), Available, current", () => {
    const person = { id: "p1", user_id: "u-me", name: "Me" } as PersonRow;
    const ops = addVersionOps({
      contentId: "c1",
      versions: map([version({ version: "V02", is_current: true })]),
      persons: new Map([["p1", person]]),
      userId: "u-me",
      id: "new",
      now: new Date(2026, 8, 30),
    });
    expect(ops).toEqual([
      {
        op: "create",
        table: "content_versions",
        id: "new",
        fields: {
          content_id: "c1",
          version: "V03",
          date: "2026-09-30",
          rendered_by: "p1",
          status: "Available",
          is_current: true,
        },
      },
    ]);
    const anon = addVersionOps({
      contentId: "c1",
      versions: new Map(),
      persons: new Map(),
      userId: "u-me",
    });
    expect(anon[0]).toMatchObject({ fields: { version: "V01", rendered_by: null } });
  });

  it("restores a deleted version with the same id and fields", () => {
    const v = version({ version: "V04", changes: "warmer", is_current: true, status: "Available" });
    expect(restoreVersionOps(v)[0]).toMatchObject({
      op: "create",
      id: v.id,
      fields: { version: "V04", changes: "warmer", is_current: true, content_id: "c1" },
    });
  });
});

describe("content versions in the optimistic store (mirrors the op engine)", () => {
  const ctx = { userId: "u", now: 100 };
  function run(data: ShowData, ops: Parameters<typeof resolveLocal>[1]) {
    return applyResolved(data, resolveLocal(data, ops, ctx));
  }
  function withContent(): ShowData {
    return run(emptyData(), [{ op: "create", table: "content", id: "c1", fields: {} }]);
  }
  const cur = (d: ShowData) =>
    [...d.tables.content_versions.values()]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((v) => [v.version, v.is_current]);

  it("first version current; a new current one clears the others; positions increase", () => {
    let d = withContent();
    d = run(d, [
      {
        op: "create",
        table: "content_versions",
        id: "a",
        fields: { content_id: "c1", version: "V01" },
      },
    ]);
    d = run(d, [
      {
        op: "create",
        table: "content_versions",
        id: "b",
        fields: { content_id: "c1", version: "V02" },
      },
    ]);
    expect(cur(d)).toEqual([
      ["V01", true],
      ["V02", false],
    ]);
    d = run(d, [
      { op: "update", table: "content_versions", id: "b", fields: { is_current: true } },
    ]);
    expect(cur(d)).toEqual([
      ["V01", false],
      ["V02", true],
    ]);
    expect(d.tables.content_versions.get("b")?.position).toBe(2);
  });

  it("deleting the current version promotes the newest remaining one", () => {
    let d = withContent();
    d = run(d, [
      {
        op: "create",
        table: "content_versions",
        id: "a",
        fields: { content_id: "c1", version: "V01" },
      },
      {
        op: "create",
        table: "content_versions",
        id: "b",
        fields: { content_id: "c1", version: "V02" },
      },
      {
        op: "create",
        table: "content_versions",
        id: "c",
        fields: { content_id: "c1", version: "V03" },
      },
    ]);
    d = run(d, [{ op: "delete", table: "content_versions", id: "a" }]);
    expect(cur(d)).toEqual([
      ["V02", false],
      ["V03", true],
    ]);
  });

  it("un-currenting the current version promotes the newest other one", () => {
    let d = withContent();
    d = run(
      d,
      ["a", "b", "c"].map((id, i) => ({
        op: "create" as const,
        table: "content_versions" as const,
        id,
        fields: { content_id: "c1", version: `V0${i + 1}` },
      })),
    );
    d = run(d, [
      { op: "update", table: "content_versions", id: "a", fields: { is_current: false } },
    ]);
    expect(cur(d)).toEqual([
      ["V01", false],
      ["V02", false],
      ["V03", true],
    ]);
  });

  it("deleting content deletes its versions and attachments", () => {
    let d = withContent();
    d = run(d, [
      { op: "create", table: "content_versions", id: "a", fields: { content_id: "c1" } },
    ]);
    d = {
      ...d,
      tables: {
        ...d.tables,
        attachments: new Map([
          [
            "f1",
            {
              id: "f1",
              table: "content",
              record_id: "c1",
              field: "attachments",
              position: 1,
            } as never,
          ],
        ]),
      },
    };
    const ops = resolveLocal(d, [{ op: "delete", table: "content", id: "c1" }], ctx);
    expect(ops.map((o) => (o.op === "meta" ? [o.op] : [o.op, o.table, o.id]))).toEqual([
      ["delete", "content_versions", "a"],
      ["delete", "attachments", "f1"],
      ["delete", "content", "c1"],
    ]);
    const after = applyResolved(d, ops);
    expect(after.tables.content_versions.size).toBe(0);
    expect(after.tables.attachments.size).toBe(0);
  });
});
