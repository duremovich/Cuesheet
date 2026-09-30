import { describe, expect, it } from "vitest";
import { defaultViewConfig } from "../../../shared/views";
import {
  applyLegacyPrefs,
  clearLegacyPrefs,
  hasViewSettings,
  type KeyValueStore,
  legacyKey,
  readLegacyPrefs,
} from "./legacy";

function memory(entries: Record<string, string>): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => void data.delete(k),
  };
}

describe("M1c prefs → saved views", () => {
  it("reads widths, the live sort and collapsed groups; ignores junk", () => {
    const store = memory({
      [legacyKey.widths("show", "cues")]: JSON.stringify({ number: 90.4, description: -5, x: "a" }),
      [legacyKey.sort("show", "cues")]: JSON.stringify([
        { key: "number", dir: "asc" },
        { key: 1, dir: "up" },
      ]),
      [legacyKey.collapsed("u1", "show", "cues")]: JSON.stringify(["scene-1"]),
      [legacyKey.widths("show", "notes")]: "{not json",
    });
    const prefs = readLegacyPrefs(store, "show", "u1", "cues");
    expect(prefs).toEqual({
      widths: { number: 90 },
      sorts: [{ key: "number", dir: "asc" }],
      collapsed: ["scene-1"],
    });
    expect(prefs && hasViewSettings(prefs)).toBe(true);
    expect(readLegacyPrefs(store, "show", "u1", "notes")).toBeNull();
    expect(readLegacyPrefs(store, "other", "u1", "cues")).toBeNull();
  });

  it("collapsed groups alone are not view settings", () => {
    const store = memory({ [legacyKey.collapsed("u1", "show", "notes")]: '["status:Done"]' });
    const prefs = readLegacyPrefs(store, "show", "u1", "notes");
    expect(prefs?.collapsed).toEqual(["status:Done"]);
    expect(prefs && hasViewSettings(prefs)).toBe(false);
  });

  it("applies widths without moving columns, and the sort as a live sort", () => {
    const base = defaultViewConfig("cues");
    const out = applyLegacyPrefs(
      base,
      { widths: { scene: 300 }, sorts: [{ key: "number", dir: "asc" }], collapsed: undefined },
      ["number", "description", "scene"],
    );
    expect(out.fields).toEqual([
      { key: "number" },
      { key: "description" },
      { key: "scene", width: 300 },
    ]);
    expect(out.sortMode).toBe("live");
    expect(out.sorts).toEqual([{ key: "number", dir: "asc" }]);
    // Widths for listed columns only touch those entries.
    const listed = applyLegacyPrefs(
      { ...base, fields: [{ key: "scene", hidden: true }, { key: "number" }] },
      { widths: { number: 50 }, sorts: [], collapsed: undefined },
      ["number", "scene"],
    );
    expect(listed.fields).toEqual([
      { key: "scene", hidden: true },
      { key: "number", width: 50 },
    ]);
    expect(listed.sortMode).toBe("none");
  });

  it("clears the old keys", () => {
    const store = memory({
      [legacyKey.widths("show", "cues")]: "{}",
      [legacyKey.sort("show", "cues")]: "[]",
      [legacyKey.collapsed("u1", "show", "cues")]: "[]",
      keep: "1",
    });
    clearLegacyPrefs(store, "show", "u1", "cues");
    expect([...store.data.keys()]).toEqual(["keep"]);
  });
});
