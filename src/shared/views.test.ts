import { describe, expect, it } from "vitest";
import {
  defaultViewConfig,
  normalizeViewConfig,
  sanitizeViewConfig,
  viewConfigError,
} from "./views";

describe("view config", () => {
  it("defaults per table", () => {
    expect(defaultViewConfig("cues")).toMatchObject({
      group: { key: "scene" },
      sortMode: "none",
      fields: [],
      filters: [],
    });
    expect(defaultViewConfig("notes").group.key).toBe("status");
    expect(defaultViewConfig("content").group.key).toBe("scene");
    expect(defaultViewConfig("persons").group.key).toBeNull();
    for (const t of ["cues", "notes", "content", "scenes", "persons"] as const) {
      expect(viewConfigError(defaultViewConfig(t))).toBeNull();
    }
  });

  it("validates strictly (server)", () => {
    const ok = defaultViewConfig("cues");
    expect(
      viewConfigError({ ...ok, filters: [{ key: "status", op: "is", value: "Cued" }] }),
    ).toBeNull();
    expect(viewConfigError({ ...ok, filters: [{ key: "", op: "is" }] })).toMatch(/key/);
    expect(viewConfigError({ ...ok, filters: [{ key: "a", op: "is", value: {} }] })).toMatch(
      /value/,
    );
    expect(viewConfigError({ ...ok, sortMode: "sometimes" })).toMatch(/sortMode/);
    expect(viewConfigError({ ...ok, fields: [{ key: "a" }, { key: "a" }] })).toMatch(/twice/);
    expect(viewConfigError({ ...ok, frozenCount: 11 })).toMatch(/frozenCount/);
    expect(
      viewConfigError({
        ...ok,
        colorRules: [{ when: [], mode: "and", target: { cell: "number" }, color: "green" }],
      }),
    ).toBeNull();
    expect(
      viewConfigError({
        ...ok,
        colorRules: [{ when: [], mode: "xor", target: "row", color: "green" }],
      }),
    ).toMatch(/mode/);
    expect(viewConfigError(null)).toMatch(/object/);
  });

  it("normalizes leniently (client): bad parts fall back to the table default", () => {
    const n = normalizeViewConfig(
      { filters: "x", rowHeight: "tall", group: { key: 5 }, colorRules: [{ bad: true }] },
      "notes",
    );
    expect(n.rowHeight).toBe("tall");
    expect(n.filters).toEqual([]);
    expect(n.group).toEqual({ key: "status" });
    expect(n.colorRules).toEqual([]);
    expect(normalizeViewConfig(undefined, "cues")).toEqual(defaultViewConfig("cues"));
  });
});

describe("view layout (R19)", () => {
  it("grid by default (stored as absent); gallery kept; anything else refused", () => {
    const ok = defaultViewConfig("content");
    expect(ok.layout).toBeUndefined();
    expect(viewConfigError({ ...ok, layout: "gallery" })).toBeNull();
    expect(viewConfigError({ ...ok, layout: "grid" })).toBeNull();
    expect(viewConfigError({ ...ok, layout: "kanban" })).toMatch(/layout/);
    expect(normalizeViewConfig({ ...ok, layout: "gallery" }, "content").layout).toBe("gallery");
    expect(normalizeViewConfig({ ...ok, layout: "grid" }, "content")).not.toHaveProperty("layout");
    expect(normalizeViewConfig({ ...ok, layout: 7 }, "content")).not.toHaveProperty("layout");
    const s = sanitizeViewConfig("content", { ...ok, layout: "gallery" });
    expect("config" in s && s.config.layout).toBe("gallery");
    const g = sanitizeViewConfig("content", { ...ok, layout: "grid" });
    expect("config" in g && g.config).not.toHaveProperty("layout");
  });
});
