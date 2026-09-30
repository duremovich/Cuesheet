import { describe, expect, it } from "vitest";
import type { Filter } from "../../../shared/views";
import { defaultViewConfig } from "../../../shared/views";
import type { ColorRule, Column, PickerItem } from "../../components/grid/types";
import {
  applyLayoutOverlay,
  compareScalar,
  compileFilters,
  differsOnlyInLayout,
  type FieldDef,
  fieldList,
  gridColorRules,
  gridSort,
  isComplete,
  layoutColumns,
  layoutOverlayOf,
  matchesFilter,
  migrateLinkFilters,
  opsFor,
  withFieldOrder,
} from "./evaluate";

interface R {
  number: string;
  qty: number | null;
  done: boolean;
  status: string | null;
  types: string[];
  scene: PickerItem | null;
  people: PickerItem[];
  created: number;
  body: string;
}

const col = <K extends keyof R>(
  key: K,
  type: Column<R>["type"],
  extra: Partial<FieldDef<R>> = {},
): FieldDef<R> => ({ key, title: key, type, getValue: (r) => r[key], ...extra });

const F = {
  number: col("number", "text"),
  qty: col("qty", "number"),
  done: col("done", "checkbox"),
  status: col("status", "select", {
    options: [{ value: "Not started" }, { value: "Rendered" }, { value: "Cued" }],
  }),
  types: col("types", "multiselect", { options: [{ value: "Content" }, { value: "Director" }] }),
  scene: col("scene", "link"),
  people: col("people", "multilink"),
  created: col("created", "readonly", { valueType: "date" }),
  body: col("body", "longtext"),
};
const fields = new Map<string, FieldDef<R>>(Object.values(F).map((f) => [f.key, f]));

const row = (patch: Partial<R> = {}): R => ({
  number: "14.20",
  qty: 3,
  done: false,
  status: "Cued",
  types: ["Content"],
  scene: { id: "s1", label: "105 Backstage" },
  people: [
    { id: "p1", label: "Alice" },
    { id: "p2", label: "Bob" },
  ],
  created: new Date(2026, 8, 15, 14, 30).getTime(),
  body: "Add grunge overlay",
  ...patch,
});

const m = (field: FieldDef<R>, filter: Omit<Filter, "key">, r = row()) =>
  matchesFilter(field, r, { key: field.key, ...filter });

describe("matchesFilter by type", () => {
  it("text: contains / is (case-insensitive) / empty / compares cue numbers as decimals", () => {
    expect(m(F.body, { op: "contains", value: "GRUNGE" })).toBe(true);
    expect(m(F.body, { op: "notContains", value: "grunge" })).toBe(false);
    expect(m(F.body, { op: "is", value: "add grunge overlay" })).toBe(true);
    expect(m(F.body, { op: "isNot", value: "x" })).toBe(true);
    expect(m(F.number, { op: "is", value: "14.2" })).toBe(true); // 14.20 = 14.2
    expect(m(F.number, { op: "gt", value: "14.19" })).toBe(true);
    expect(m(F.number, { op: "lt", value: "14.3" })).toBe(true);
    expect(m(F.number, { op: "lt", value: "9" })).toBe(false); // numeric, not text
    expect(m(F.number, { op: "gte", value: "14.20" })).toBe(true);
    expect(m(F.number, { op: "lte", value: "14.19" })).toBe(false);
    const blank = row({ body: "  " });
    expect(m(F.body, { op: "isEmpty" }, blank)).toBe(true);
    expect(m(F.body, { op: "isNotEmpty" }, blank)).toBe(false);
    expect(m(F.body, { op: "contains", value: "a" }, blank)).toBe(false);
    expect(m(F.body, { op: "isNot", value: "a" }, blank)).toBe(true);
  });

  it("number", () => {
    expect(m(F.qty, { op: "is", value: 3 })).toBe(true);
    expect(m(F.qty, { op: "gt", value: 2 })).toBe(true);
    expect(m(F.qty, { op: "lte", value: 2 })).toBe(false);
    expect(m(F.qty, { op: "gt", value: 2 }, row({ qty: null }))).toBe(false);
    expect(m(F.qty, { op: "isEmpty" }, row({ qty: null }))).toBe(true);
  });

  it("checkbox", () => {
    expect(m(F.done, { op: "isTrue" })).toBe(false);
    expect(m(F.done, { op: "isFalse" })).toBe(true);
    expect(m(F.done, { op: "isTrue" }, row({ done: true }))).toBe(true);
  });

  it("select: is / isNot / anyOf / noneOf / empty", () => {
    expect(m(F.status, { op: "is", value: "Cued" })).toBe(true);
    expect(m(F.status, { op: "is", value: "cued" })).toBe(true);
    expect(m(F.status, { op: "isNot", value: "Cued" })).toBe(false);
    expect(m(F.status, { op: "anyOf", value: ["Rendered", "Cued"] })).toBe(true);
    expect(m(F.status, { op: "noneOf", value: ["Rendered", "Cued"] })).toBe(false);
    expect(m(F.status, { op: "isEmpty" }, row({ status: null }))).toBe(true);
    expect(m(F.status, { op: "isNot", value: "Cued" }, row({ status: null }))).toBe(true);
  });

  it("multiselect: has / has any of / has none of", () => {
    expect(m(F.types, { op: "is", value: "Content" })).toBe(true);
    expect(m(F.types, { op: "isNot", value: "Director" })).toBe(true);
    expect(m(F.types, { op: "anyOf", value: ["Director"] })).toBe(false);
    expect(m(F.types, { op: "noneOf", value: ["Director"] })).toBe(true);
    expect(m(F.types, { op: "isEmpty" }, row({ types: [] }))).toBe(true);
  });

  it("links compare by label", () => {
    expect(m(F.scene, { op: "is", value: "105 backstage" })).toBe(true);
    expect(m(F.scene, { op: "contains", value: "back" })).toBe(true);
    expect(m(F.scene, { op: "isEmpty" }, row({ scene: null }))).toBe(true);
    expect(m(F.people, { op: "is", value: "Bob" })).toBe(true);
    expect(m(F.people, { op: "isNot", value: "Carol" })).toBe(true);
    expect(m(F.people, { op: "anyOf", value: ["Carol", "alice"] })).toBe(true);
    expect(m(F.people, { op: "noneOf", value: ["Alice"] })).toBe(false);
    expect(m(F.people, { op: "notContains", value: "li" })).toBe(false);
  });

  it("dates: before / after a day (local time)", () => {
    expect(m(F.created, { op: "before", value: "2026-09-16" })).toBe(true);
    expect(m(F.created, { op: "before", value: "2026-09-15" })).toBe(false);
    expect(m(F.created, { op: "after", value: "2026-09-14" })).toBe(true);
    expect(m(F.created, { op: "after", value: "2026-09-15" })).toBe(false); // same day
    expect(m(F.created, { op: "after", value: "garbage" })).toBe(false);
  });

  it("offers operators by type", () => {
    expect(opsFor(F.done)).toEqual(["isTrue", "isFalse"]);
    expect(opsFor(F.created)).toContain("before");
    expect(opsFor(F.status)).toContain("anyOf");
    expect(opsFor(F.number)).toContain("contains");
  });
});

describe("compileFilters", () => {
  const rows = [
    row({ number: "1", status: "Cued" }),
    row({ number: "2", status: "Rendered" }),
    row({ number: "3", status: null }),
  ];
  const nums = (pred: ((r: R) => boolean) | null) =>
    pred ? rows.filter(pred).map((r) => r.number) : "all";

  it("and / or; skips incomplete filters and unknown fields", () => {
    const cued: Filter = { key: "status", op: "is", value: "Cued" };
    const three: Filter = { key: "number", op: "is", value: "3" };
    expect(nums(compileFilters([cued], "and", fields, true))).toEqual(["1"]);
    expect(nums(compileFilters([cued, three], "and", fields, true))).toEqual([]);
    expect(nums(compileFilters([cued, three], "or", fields, true))).toEqual(["1", "3"]);
    // Incomplete (no value) and unknown-field filters don't hide anything.
    expect(nums(compileFilters([{ key: "status", op: "is" }], "and", fields, true))).toBe("all");
    expect(nums(compileFilters([{ key: "gone", op: "isEmpty" }], "and", fields, true))).toBe("all");
    // …but a color rule with nothing complete matches nothing.
    expect(nums(compileFilters([], "and", fields, false))).toEqual([]);
  });

  it("isComplete", () => {
    expect(isComplete({ key: "a", op: "isEmpty" })).toBe(true);
    expect(isComplete({ key: "a", op: "is", value: " " })).toBe(false);
    expect(isComplete({ key: "a", op: "anyOf", value: [] })).toBe(false);
    expect(isComplete({ key: "a", op: "gt", value: 0 })).toBe(true);
  });

  it("compareScalar: decimals numerically, else natural order", () => {
    expect(compareScalar("14.2", "14.20")).toBe(0);
    expect(compareScalar("14.25", "14.3A")).toBeLessThan(0);
    expect(compareScalar("14.05A", "14.5")).toBeLessThan(0);
    expect(m(F.number, { op: "lt", value: "14.3A" }, row({ number: "14.25" }))).toBe(true);
    expect(m(F.number, { op: "gt", value: "14.5" }, row({ number: "14.05A" }))).toBe(false);
    expect(m(F.number, { op: "is", value: "14.3a" }, row({ number: "14.30A" }))).toBe(true);
    expect(compareScalar("9", "10")).toBeLessThan(0);
    expect(compareScalar("8.5A", "8.5B")).toBeLessThan(0);
  });
});

/** The grid's semantics: the first matching row rule wins; cell rules stack (later wins). */
function colorsOf(rules: ColorRule<R>[], r: R) {
  let rowColor: string | undefined;
  const cells: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.when(r)) continue;
    if (rule.row && rowColor === undefined) rowColor = rule.row;
    if (rule.cell) cells[rule.cell.key] = rule.cell.color;
  }
  return { rowColor, cells };
}

describe("gridColorRules", () => {
  it("keeps rule order: first row match wins, cell rules stack", () => {
    const rules = gridColorRules(
      [
        {
          when: [{ key: "status", op: "is", value: "Cued" }],
          mode: "and",
          target: "row",
          color: "green",
        },
        { when: [{ key: "qty", op: "gt", value: 1 }], mode: "and", target: "row", color: "red" },
        {
          when: [{ key: "people", op: "isNotEmpty" }],
          mode: "and",
          target: { cell: "people" },
          color: "blue",
        },
        {
          when: [{ key: "qty", op: "gt", value: 2 }],
          mode: "and",
          target: { cell: "people" },
          color: "pink",
        },
        // An incomplete rule never colors; a rule on a missing cell is dropped.
        { when: [{ key: "status", op: "is" }], mode: "and", target: "row", color: "yellow" },
        { when: [], mode: "and", target: { cell: "gone" }, color: "teal" },
      ],
      fields,
    );
    expect(rules).toHaveLength(5);
    expect(colorsOf(rules, row())).toEqual({ rowColor: "green", cells: { people: "pink" } });
    expect(colorsOf(rules, row({ status: "Rendered", qty: 2 }))).toEqual({
      rowColor: "red",
      cells: { people: "blue" },
    });
    expect(colorsOf(rules, row({ status: null, qty: 0, people: [] }))).toEqual({
      rowColor: undefined,
      cells: {},
    });
  });

  it("or rules match on any condition", () => {
    const [rule] = gridColorRules(
      [
        {
          when: [
            { key: "status", op: "is", value: "Rendered" },
            { key: "done", op: "isTrue" },
          ],
          mode: "or",
          target: "row",
          color: "orange",
        },
      ],
      fields,
    );
    expect(rule?.when(row({ done: true }))).toBe(true);
    expect(rule?.when(row())).toBe(false);
  });
});

describe("layout and sort", () => {
  const cols: Column<R>[] = [F.number, F.body, F.status, F.people].map((c, i) => ({
    ...c,
    width: 100 + i,
    ...(i === 0 ? { frozen: true } : {}),
  }));

  it("orders, hides, sizes and freezes columns from the view", () => {
    const config = {
      ...defaultViewConfig("cues"),
      fields: [
        { key: "status", width: 222 },
        { key: "number" },
        { key: "body", hidden: true },
        { key: "unknown" },
      ],
      frozenCount: 2,
    };
    const out = layoutColumns(cols, config);
    expect(out.map((c) => c.key)).toEqual(["status", "number", "people"]);
    expect(out.map((c) => c.width)).toEqual([222, 100, 103]);
    expect(out.map((c) => !!c.frozen)).toEqual([true, true, false]);
    // No config: every column, default order, the first frozen.
    const plain = layoutColumns(cols, defaultViewConfig("cues"));
    expect(plain.map((c) => c.key)).toEqual(["number", "body", "status", "people"]);
    expect(plain[0]).toBe(cols[0]); // unchanged columns keep identity
  });

  it("fieldList / withFieldOrder round-trip hidden flags and widths", () => {
    const config = { ...defaultViewConfig("cues"), fields: [{ key: "body", width: 300 }] };
    const list = fieldList(cols, config);
    expect(list.map((f) => f.key)).toEqual(["body", "number", "status", "people"]);
    const next = withFieldOrder(cols, config, [
      { key: "number", hidden: false },
      { key: "body", hidden: true },
      { key: "status", hidden: false },
      { key: "people", hidden: false },
    ]);
    expect(next).toEqual([
      { key: "number" },
      { key: "body", width: 300, hidden: true },
      { key: "status" },
      { key: "people" },
    ]);
  });

  it("gridSort applies only in live mode, over known columns (hidden ones too)", () => {
    const base = defaultViewConfig("cues");
    const sorts = [
      { key: "number", dir: "asc" as const },
      { key: "body", dir: "desc" as const },
    ];
    expect(gridSort({ ...base, sorts, sortMode: "none" }, cols)).toBeUndefined();
    expect(gridSort({ ...base, sorts, sortMode: "live" }, cols)).toEqual(sorts);
    expect(gridSort({ ...base, sorts, sortMode: "live" }, cols.slice(0, 1))).toEqual([sorts[0]]);
    expect(gridSort({ ...base, sorts: [], sortMode: "live" }, cols)).toBeUndefined();
  });
});

describe("link filters store ids", () => {
  const SCENE_ID = "0190a1b2-0000-7000-8000-000000000001";
  const withScene = (label: string) => row({ scene: { id: SCENE_ID, label } });

  it("match by id, so renaming the record keeps the filter working", () => {
    const f: Filter = { key: "scene", op: "is", value: SCENE_ID, labels: { [SCENE_ID]: "105" } };
    expect(matchesFilter(F.scene, withScene("105 Backstage"), f)).toBe(true);
    expect(matchesFilter(F.scene, withScene("105 Renamed"), f)).toBe(true);
    const other = row({ scene: { id: "other", label: "105 Backstage" } });
    expect(matchesFilter(F.scene, other, f)).toBe(false);
    const any: Filter = { key: "scene", op: "anyOf", value: [SCENE_ID] };
    expect(matchesFilter(F.scene, withScene("x"), any)).toBe(true);
  });

  it("migrates label filters to ids once, caching the label; unknown labels stay", () => {
    const config = {
      ...defaultViewConfig("notes"),
      filters: [
        { key: "scene", op: "is", value: "105 backstage" },
        { key: "people", op: "anyOf", value: ["Alice", "Nobody"] },
        { key: "body", op: "contains", value: "grunge" },
      ] as Filter[],
      colorRules: [
        {
          when: [{ key: "scene", op: "isNot", value: "105 Backstage" }] as Filter[],
          mode: "and" as const,
          target: "row" as const,
          color: "red" as const,
        },
      ],
    };
    const known: PickerItem[] = [
      { id: SCENE_ID, label: "105 Backstage" },
      { id: "0190a1b2-0000-7000-8000-00000000000a", label: "Alice" },
    ];
    const lookup = (_f: FieldDef<R>, label: string) =>
      known.find((p) => p.label.toLowerCase() === label.toLowerCase());
    const out = migrateLinkFilters(config, fields, lookup);
    expect(out.filters[0]).toEqual({
      key: "scene",
      op: "is",
      value: SCENE_ID,
      labels: { [SCENE_ID]: "105 Backstage" },
    });
    expect(out.filters[1]?.value).toEqual(["0190a1b2-0000-7000-8000-00000000000a", "Nobody"]);
    expect(out.filters[2]).toBe(config.filters[2]);
    expect(out.colorRules[0]?.when[0]?.value).toBe(SCENE_ID);
    // Unresolved labels still match by label; already-migrated configs come back as-is.
    expect(matchesFilter(F.people, row(), out.filters[1] as Filter)).toBe(false);
    expect(migrateLinkFilters(out, fields, lookup)).toBe(out);
  });
});

describe("layout overlay (viewers' own widths)", () => {
  const cols: Column<R>[] = [F.number, F.body, F.status];

  it("applies widths and frozen count without moving columns", () => {
    const base = { ...defaultViewConfig("cues"), fields: [{ key: "status" }] };
    const out = applyLayoutOverlay(base, { widths: { body: 333 }, frozenCount: 2 }, [
      "number",
      "body",
      "status",
    ]);
    expect(out.fields).toEqual([{ key: "status" }, { key: "number" }, { key: "body", width: 333 }]);
    expect(out.frozenCount).toBe(2);
    expect(layoutColumns(cols, out).map((c) => c.key)).toEqual(
      layoutColumns(cols, base).map((c) => c.key),
    );
    expect(layoutOverlayOf(out)).toEqual({ widths: { body: 333 }, frozenCount: 2 });
  });

  it("tells layout-only changes from real ones", () => {
    const base = defaultViewConfig("cues");
    const wider = {
      ...base,
      fields: [{ key: "number" }, { key: "body", width: 400 }, { key: "status" }],
    };
    expect(differsOnlyInLayout(base, wider, cols)).toBe(true);
    expect(differsOnlyInLayout(base, { ...base, frozenCount: 3 }, cols)).toBe(true);
    expect(differsOnlyInLayout(base, { ...base, rowHeight: "tall" }, cols)).toBe(false);
    const hidden = { ...base, fields: [{ key: "body", hidden: true }] };
    expect(differsOnlyInLayout(base, hidden, cols)).toBe(false);
    const moved = { ...base, fields: [{ key: "status" }] };
    expect(differsOnlyInLayout(base, moved, cols)).toBe(false);
  });
});
