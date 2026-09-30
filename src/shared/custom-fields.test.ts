import { describe, expect, it } from "vitest";
import {
  checkCustomValue,
  checkFieldOptions,
  csvValue,
  customFieldKind,
  guessFieldType,
  isCustomKey,
  refitValue,
  slugify,
} from "./custom-fields";

describe("custom field keys", () => {
  it("slugify: lowercase, unique, starts with a letter", () => {
    expect(slugify("Shoot day #2")).toBe("shoot_day_2");
    expect(slugify("Café Crème")).toBe("cafe_creme");
    expect(slugify("2nd unit")).toBe("f_2nd_unit");
    expect(slugify("!!!")).toBe("field");
    expect(slugify("Name", ["name", "name_2"])).toBe("name_3");
    expect(isCustomKey(slugify("x".repeat(100)))).toBe(true);
    expect(isCustomKey("Bad Key")).toBe(false);
  });
});

describe("type guessing (CSV import)", () => {
  const guess = (h: string, v: string[]) => guessFieldType(h, v).type;
  it("from the Network, Reference Links, Calendar and Millumin examples", () => {
    expect(guess("IP", ["192.168.11.163", "", "DHCP"])).toBe("text");
    expect(guess("IP", ["192.168.11.163", "10.10.0.1"])).toBe("text");
    expect(guessFieldType("Password", ["REDACTED"])).toEqual({
      type: "text",
      options: { sensitive: true },
    });
    expect(guess("Notes", ["https://example.com/a", "https://x.org/b - SOURCE/IMAGES"])).toBe("url");
    expect(guess("PIN", ["checked", "", "checked"])).toBe("checkbox");
    expect(guess("Date", ["2026-09-01", "9/12/2026"])).toBe("date");
    expect(guess("Count", ["1", "2.5", "-3"])).toBe("number");
    expect(guess("Attachments", ["a.png (https://…)"])).toBe("attachment");
    expect(guess("Notes", ["x".repeat(120)])).toBe("longtext");
    const status = guessFieldType("Status", ["Done", "Open", "Done"]);
    expect(status.type).toBe("select");
    expect(status.options.choices?.map((c) => c.value)).toEqual(["Done", "Open"]);
    expect(guess("Milestone", ["First Design Meeting"])).toBe("text");
    expect(guess("Empty", ["", " "])).toBe("text");
  });

  it("CSV cells as values", () => {
    expect(csvValue("checkbox", "checked")).toBe(true);
    expect(csvValue("number", "1,250.5")).toBe(1250.5);
    expect(csvValue("date", "9/3/2026")).toBe("2026-09-03");
    expect(csvValue("url", "www.x.com")).toBe("https://www.x.com");
    expect(csvValue("text", "  ")).toBeNull();
  });
});

describe("values and options", () => {
  const f = (type: string, options = {}) =>
    ({ type, options, label: "F", key: "f" }) as Parameters<typeof checkCustomValue>[0];
  it("checks values by type", () => {
    expect(checkCustomValue(f("number"), 3)).toEqual({ value: 3 });
    expect(checkCustomValue(f("number"), "3")).toMatchObject({ error: expect.any(String) });
    expect(checkCustomValue(f("select", { choices: [{ value: "A", color: "red" }] }), "A")).toEqual({
      value: "A",
    });
    expect(checkCustomValue(f("link"), [])).toEqual({ value: null });
    expect(checkCustomValue(f("link", { multiple: false }), ["a", "b"])).toMatchObject({
      error: expect.any(String),
    });
    expect(checkCustomValue(f("formula", { formula: "1" }), 1)).toMatchObject({
      error: expect.any(String),
    });
    expect(checkCustomValue(f("text"), null)).toEqual({ value: null });
  });

  it("options: known keys only, per type", () => {
    expect(checkFieldOptions("text", { sensitive: true, choices: [] })).toEqual({
      options: { sensitive: true },
    });
    expect(checkFieldOptions("select", { choices: [{ value: "A" }] })).toEqual({
      options: { choices: [{ value: "A", color: "gray" }] },
    });
    expect(checkFieldOptions("select", { choices: [{ value: "A" }, { value: "A" }] })).toMatchObject({
      error: expect.any(String),
    });
    expect(checkFieldOptions("link", { target: "custom:bad" })).toMatchObject({
      error: expect.any(String),
    });
    expect(checkFieldOptions("number", { decimals: 9 })).toMatchObject({ error: expect.any(String) });
  });

  it("refit on a type or choice change", () => {
    const sel = f("multiselect", { choices: [{ value: "B" }] });
    expect(refitValue("multiselect", sel, ["A", "B"])).toEqual(["B"]);
    expect(refitValue("multiselect", sel, ["A"])).toBeNull();
    expect(refitValue("text", f("longtext"), "x")).toBe("x");
    expect(refitValue("text", f("number"), "3")).toBeNull();
    expect(refitValue("number", f("number", { decimals: 2 }), 3)).toBe(3);
  });

  it("view kinds", () => {
    expect(customFieldKind("multiselect")).toBe("multi");
    expect(customFieldKind("datetime")).toBe("date");
    expect(customFieldKind("formula")).toBe("text");
    expect(customFieldKind("url")).toBe("text");
  });
});
