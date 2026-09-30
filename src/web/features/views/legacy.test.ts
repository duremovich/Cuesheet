import { describe, expect, it } from "vitest";
import { defaultViewConfig } from "../../../shared/views";
import { applyLayoutOverlay } from "./evaluate";
import { clearLegacyPrefs, type KeyValueStore, legacyKey, readLegacyPrefs } from "./legacy";

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
    expect(readLegacyPrefs(store, "show", "u1", "notes")).toBeNull();
    expect(readLegacyPrefs(store, "other", "u1", "cues")).toBeNull();
  });

  it("collapsed groups alone", () => {
    const store = memory({ [legacyKey.collapsed("u1", "show", "notes")]: '["status:Done"]' });
    const prefs = readLegacyPrefs(store, "show", "u1", "notes");
    expect(prefs?.collapsed).toEqual(["status:Done"]);
    expect(prefs?.widths).toEqual({});
  });

  it("old widths become a layout overlay on the shared view (nothing else changes)", () => {
    const base = defaultViewConfig("cues");
    const out = applyLayoutOverlay(base, { widths: { scene: 300 } }, [
      "number",
      "description",
      "scene",
    ]);
    expect(out.fields).toEqual([
      { key: "number" },
      { key: "description" },
      { key: "scene", width: 300 },
    ]);
    expect({ ...out, fields: [] }).toEqual({ ...base, fields: [] });
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
