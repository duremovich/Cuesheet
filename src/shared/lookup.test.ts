// Lookup fields, the shared half: options, which link fields lead where, the kind a lookup
// has (and so how views filter it on the server), and broken or circular configurations.
import { describe, expect, it } from "vitest";
import { checkCustomValue, checkFieldOptions, isStoredType } from "./custom-fields";
import { linkTargetOf, resolveLookup } from "./lookup";
import { coreViewFields, viewFieldsFor } from "./views";

type Def = {
  table: string;
  key: string;
  type: never;
  options: Record<string, unknown>;
  label: null;
};
const def = (table: string, key: string, type: string, options: Record<string, unknown> = {}) =>
  ({ table, key, type, options, label: null }) as unknown as Def;

const fields: Def[] = [
  def("cues", "venue", "link", { target: "persons" }),
  def("cues", "mood", "select", { choices: [] }),
  def("cues", "content_scene", "lookup", { link: "content", field: "scene" }),
  def("notes", "cue_content", "lookup", { link: "cues", field: "content" }),
  def("notes", "cue_status", "lookup", { link: "cues", field: "status" }),
  def("notes", "cue_mood", "lookup", { link: "cues", field: "custom.mood" }),
  def("notes", "cue_number", "lookup", { link: "cues", field: "number" }),
  def("notes", "scenes_twice", "lookup", { link: "cues", field: "custom.content_scene" }),
  def("notes", "broken", "lookup", { link: "cues", field: "custom.gone" }),
  def("notes", "loop", "lookup", { link: "cues", field: "custom.back" }),
  def("cues", "to_notes", "link", { target: "notes" }),
  def("cues", "back", "lookup", { link: "custom.to_notes", field: "custom.loop" }),
];
const fieldsOf = (t: string) => fields.filter((f) => f.table === t);

describe("lookup fields (shared)", () => {
  it("are computed, never stored, and need a link and a field", () => {
    expect(isStoredType("lookup")).toBe(false);
    expect(checkCustomValue({ type: "lookup", options: {}, label: "X", key: "x" }, ["a"])).toEqual({
      error: "X is not stored in the row (lookup)",
    });
    expect(checkFieldOptions("lookup", { link: "cues", field: "content", extra: 1 })).toEqual({
      options: { link: "cues", field: "content" },
    });
    expect(checkFieldOptions("lookup", { link: "cues" })).toHaveProperty("error");
    expect(checkFieldOptions("lookup", { link: "", field: "x" })).toHaveProperty("error");
  });

  it("go through core links, references, reverse links and custom links", () => {
    expect(linkTargetOf("notes", "cues", fieldsOf)).toBe("cues");
    expect(linkTargetOf("cues", "scene", fieldsOf)).toBe("scenes");
    expect(linkTargetOf("content", "cues", fieldsOf)).toBe("cues");
    expect(linkTargetOf("cues", "custom.venue", fieldsOf)).toBe("persons");
    expect(linkTargetOf("cues", "custom.mood", fieldsOf)).toBeNull();
    expect(linkTargetOf("cues", "number", fieldsOf)).toBeNull();
    expect(linkTargetOf("cues", "__proto__", fieldsOf)).toBeNull();
  });

  it("take the kind of the field they show; views on the server agree", () => {
    const kinds = viewFieldsFor("notes", fieldsOf("notes"), fieldsOf);
    expect(kinds["custom.cue_content"]).toEqual({ kind: "link" });
    expect(kinds["custom.cue_status"]).toEqual({ kind: "multi" });
    expect(kinds["custom.cue_mood"]).toEqual({ kind: "multi" });
    expect(kinds["custom.cue_number"]).toEqual({ kind: "text" });
    expect(kinds["custom.scenes_twice"]).toEqual({ kind: "link" });
    expect(kinds["custom.broken"]).toEqual({ kind: "text" });
    expect(kinds["custom.loop"]).toEqual({ kind: "text" });
    // Without the other tables' fields a lookup is text.
    expect(viewFieldsFor("notes", fieldsOf("notes"))["custom.cue_content"]).toEqual({
      kind: "text",
    });
  });

  it("missing fields are #NAME and cycles #ERROR", () => {
    const r = (key: string) =>
      resolveLookup(fields.find((f) => f.key === key) as never, fieldsOf, coreViewFields);
    expect(r("cue_content")).toEqual({ ok: true, kind: "link", target: "cues", field: "content" });
    expect(r("broken")).toMatchObject({ ok: false, code: "#NAME" });
    expect(r("loop")).toMatchObject({ ok: false, code: "#ERROR" });
    // A core field that's a filter-only extra (not a column) isn't one.
    expect(
      resolveLookup(
        def("notes", "x", "lookup", { link: "cues", field: "open_notes" }) as never,
        fieldsOf,
        coreViewFields,
      ),
    ).toMatchObject({ ok: false, code: "#NAME" });
  });
});
