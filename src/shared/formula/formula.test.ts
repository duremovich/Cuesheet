import { describe, expect, it } from "vitest";
import {
  compile,
  dependencies,
  evaluate,
  type FormulaRecord,
  formatFormulaValue,
  formulaScalar,
  parse,
  qty,
  type RecordSet,
  run,
  type Value,
} from "./index";
import { tokenize } from "./lexer";

/** A record from plain fields; arrays of records become links. */
function record(fields: Record<string, Value | FormulaRecord[]>, label?: string): FormulaRecord {
  return {
    ...(label ? { label } : {}),
    get(name: string): Value | RecordSet | undefined {
      if (!Object.hasOwn(fields, name)) return undefined;
      const v = fields[name];
      if (Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && "get" in x)) {
        return { records: v as FormulaRecord[] };
      }
      return v as Value;
    },
  };
}

const EMPTY = record({});
const calc = (src: string, rec: FormulaRecord = EMPTY): Value => {
  const r = parse(src);
  if ("error" in r) throw new Error(`parse: ${r.error}`);
  return evaluate(r.ast, rec);
};
const code = (v: Value) => (v && typeof v === "object" && "code" in v ? v.code : null);

describe("tokenizer", () => {
  it("reads numbers, strings, identifiers, braces and operators", () => {
    const t = tokenize(`ROUND(width * 2.5e1, 2) & "a ""b""" <> {Pixel width} >= .5`);
    expect(t.map((x) => [x.type, x.text])).toEqual([
      ["ident", "ROUND"],
      ["(", "("],
      ["ident", "width"],
      ["op", "*"],
      ["num", "2.5e1"],
      [",", ","],
      ["num", "2"],
      [")", ")"],
      ["op", "&"],
      ["str", 'a "b"'],
      ["op", "<>"],
      ["ident", "Pixel width"],
      ["op", ">="],
      ["num", ".5"],
      ["eof", ""],
    ]);
  });

  it("handles quote escapes in both quote styles", () => {
    expect(tokenize(`'it\\'s' "say \\"hi\\""`).map((t) => t.text)).toEqual([
      `it's`,
      `say "hi"`,
      "",
    ]);
    expect(tokenize(`'it''s'`)[0]?.text).toBe("it's");
  });
});

describe("parser", () => {
  it("reports syntax errors as values with a position", () => {
    expect(parse("1 +")).toMatchObject({ error: expect.stringMatching(/end/) });
    expect(parse("(1 + 2")).toMatchObject({ error: expect.stringMatching(/'\)'/) });
    expect(parse('"open')).toMatchObject({ error: "Unclosed string", pos: 0 });
    expect(parse("1 2")).toMatchObject({ error: 'Unexpected "2"', pos: 2 });
    expect(parse("")).toMatchObject({ error: "Empty formula" });
    expect(parse("a.")).toMatchObject({ error: expect.stringMatching(/field name/) });
    expect(parse("#")).toMatchObject({ error: 'Unexpected "#"' });
    expect(compile("1 +")).toMatchObject({ code: "#ERROR" });
  });
});

describe("arithmetic and precedence", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 - 4 - 3", 3],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["-2 * 3", -6],
    ["- -3", 3],
    ["+4", 4],
    ["7 % 4", 3],
    ["1 + 2 = 3", true],
    ["2 * 3 > 5", true],
    ["1 <> 1", false],
    ['"a" & 1 + 2', "a3"],
    ['"b" = "B"', true],
    ["10 / 4", 2.5],
  ] as const)("%s = %s", (src, want) => {
    expect(calc(src)).toEqual(want);
  });

  it("divide by zero is an error value", () => {
    expect(code(calc("1 / 0"))).toBe("#DIV/0");
    expect(code(calc("1 / 0 + 5"))).toBe("#DIV/0");
  });

  it("blank operands make arithmetic blank", () => {
    expect(calc("x * 2", record({ x: null }))).toBeNull();
    expect(calc("x > 2", record({ x: null }))).toBeNull();
  });
});

describe("functions", () => {
  it.each([
    ["IF(1 > 2, 'yes', 'no')", "no"],
    ["IF(0, 1)", null],
    ["IF(1, 1, 1/0)", 1],
    ["AND(1, 2 > 1)", true],
    ["OR(0, FALSE)", false],
    ["NOT(0)", true],
    ["ROUND(3.14159, 2)", 3.14],
    ["ROUND(2.5)", 3],
    ["MIN(3, 1, 2)", 1],
    ["MAX(3, 1, 2)", 3],
    ["ABS(-4)", 4],
    ["CONCAT('a', 1, TRUE)", "a1TRUE"],
    ["LEFT('hello', 2)", "he"],
    ["RIGHT('hello', 3)", "llo"],
    ["MID('hello', 2, 3)", "ell"],
    ["UPPER('ab')", "AB"],
    ["LOWER('AB')", "ab"],
    ["TRIM('  a   b ')", "a b"],
    ["FIND('l', 'hello')", 3],
    ["FIND('z', 'hello')", 0],
    ["FIND('l', 'hello', 4)", 4],
    ["LEN('hello')", 5],
  ] as const)("%s = %s", (src, want) => {
    expect(calc(src)).toEqual(want);
  });

  it("errors for unknown functions, fields and bad arity", () => {
    expect(code(calc("NOPE(1)"))).toBe("#NAME");
    expect(code(calc("missing + 1"))).toBe("#NAME");
    expect(code(calc("ROUND()"))).toBe("#ERROR");
    expect(code(calc("'abc' * 2"))).toBe("#VALUE");
  });

  it("propagates errors through functions but IF skips the untaken branch", () => {
    expect(code(calc("ROUND(1/0, 2)"))).toBe("#DIV/0");
    expect(code(calc("CONCAT('a', 1/0)"))).toBe("#DIV/0");
    expect(code(calc("IF(1/0, 1, 2)"))).toBe("#DIV/0");
    expect(calc("IF(0, 1/0, 2)")).toBe(2);
  });
});

describe("units", () => {
  const surface = record({
    width: qty(4.5),
    height: qty(2.5),
    pixel_width: 1920,
    pixel_height: 1080,
    lens_ratio: 1.5,
    throw_distance: qty(9),
    size: { w: 1920, h: 1080 },
  });

  it("carries lengths through arithmetic", () => {
    expect(calc("width + height", surface)).toEqual(qty(7));
    expect(calc("width * 2", surface)).toEqual(qty(9));
    expect(calc("2 * width", surface)).toEqual(qty(9));
    expect(calc("width / 2", surface)).toEqual(qty(2.25));
    expect(calc("width / height", surface)).toBeCloseTo(1.8);
    expect(calc("throw_distance / lens_ratio", surface)).toEqual(qty(6));
    expect(calc("-width", surface)).toEqual(qty(-4.5));
    expect(calc("width > height", surface)).toBe(true);
    expect(calc("MAX(width, height)", surface)).toEqual(qty(4.5));
  });

  it("dimension errors are #UNIT", () => {
    for (const src of [
      "width + 1",
      "width * height",
      "pixel_width / width",
      "width > 1",
      "width = 4.5",
      "MAX(width, 3)",
      "ASPECT(width, 3)",
      "PPI(pixel_width, 3)",
    ]) {
      expect(code(calc(src, surface)), src).toBe("#UNIT");
    }
  });

  it("converts with M/CM/MM/IN/FT both ways", () => {
    expect(calc("CM(width)", surface)).toBeCloseTo(450);
    expect(calc("MM(width)", surface)).toBeCloseTo(4500);
    expect(calc("IN(width)", surface)).toBeCloseTo(177.165, 3);
    expect(calc("FT(width)", surface)).toBeCloseTo(14.7638, 4);
    expect(calc("M(width)", surface)).toBe(4.5);
    expect((calc("IN(12)") as { value: number }).value).toBeCloseTo(0.3048, 12);
    expect((calc("width + FT(1)", surface) as { value: number }).value).toBeCloseTo(4.8048, 12);
  });

  it("PPI, PITCH, ASPECT", () => {
    expect(calc("PPI(pixel_width, width)", surface)).toBeCloseTo(10.8373, 3);
    expect(calc("PITCH(width, pixel_width)", surface)).toBeCloseTo(2.34375);
    expect(calc("ASPECT(pixel_width, pixel_height)", surface)).toBe("16:9");
    expect(calc("ASPECT(width, height)", surface)).toBe("9:5");
    expect(calc("ASPECT(1366, 768)")).toBe("1.78:1");
    expect(calc("ASPECT(size.w, size.h)", surface)).toBe("16:9");
    expect(calc("PPI(x, width)", record({ x: null, width: qty(1) }))).toBeNull();
    expect(code(calc("PPI(10, M(0))"))).toBe("#DIV/0");
  });

  it("formats lengths in the display unit", () => {
    expect(formatFormulaValue(qty(4.5), "ft-in")).toBe(`14' 9 1/8"`);
    expect(formatFormulaValue(10.83733, "m")).toBe("10.84");
    expect(formatFormulaValue(3, "m")).toBe("3");
    expect(formulaScalar(qty(4.5))).toBe(4.5);
    expect(formulaScalar({ error: "x", code: "#UNIT" })).toBeNull();
  });
});

describe("links", () => {
  const scenes = [
    record({ name: "Overture", count: 2, width: qty(1) }, "100 Overture"),
    record({ name: "Street", count: 3, width: qty(2) }, "102 Street"),
    record({ name: null, count: null, width: null }, "103"),
  ];
  const parent = record({ name: "L PRO", pixel_width: 3840, width: qty(9) }, "L PRO");
  const rec = record({ scenes, parent: [parent], none: [] });

  it("LOOKUP, COUNT, SUM, JOIN", () => {
    expect(calc("LOOKUP(parent.pixel_width)", rec)).toBe(3840);
    expect(calc("parent.width / 2", rec)).toEqual(qty(4.5));
    expect(calc("LOOKUP(scenes.name)", rec)).toEqual(["Overture", "Street", null]);
    expect(calc("COUNT(scenes)", rec)).toBe(3);
    expect(calc("COUNT(scenes.name)", rec)).toBe(2);
    expect(calc("COUNT(none)", rec)).toBe(0);
    expect(calc("SUM(scenes.count)", rec)).toBe(5);
    expect(calc("SUM(scenes.width)", rec)).toEqual(qty(3));
    expect(calc("SUM(none.count)", rec)).toBe(0);
    expect(calc("JOIN(scenes.name, ' / ')", rec)).toBe("Overture / Street");
    expect(calc("JOIN(scenes.name)", rec)).toBe("Overture, Street");
    expect(calc("LOOKUP(none.name)", rec)).toBeNull();
    expect(calc("scenes", rec)).toEqual(["100 Overture", "102 Street", "103"]);
  });

  it("errors inside links propagate; unknown link fields are #NAME", () => {
    const bad = record({ items: [record({ v: { error: "x", code: "#UNIT" } })] });
    expect(code(calc("SUM(items.v)", bad))).toBe("#UNIT");
    expect(code(calc("JOIN(items.v)", bad))).toBe("#UNIT");
    expect(code(calc("scenes.nope", rec))).toBe("#NAME");
    expect(code(calc("scenes.count + 1", rec))).toBe("#VALUE");
  });
});

describe("dependencies", () => {
  it("lists fields and link paths", () => {
    expect(
      dependencies("PPI(pixel_width, width) + LOOKUP(parent.pixel_width) * {Lens ratio}"),
    ).toEqual(["Lens ratio", "parent", "parent.pixel_width", "pixel_width", "width"]);
    expect(dependencies("1 +")).toEqual([]);
    expect(dependencies("IF(a, b.c.d, 'x')")).toEqual(["a", "b", "b.c", "b.c.d"]);
  });

  it("compile + run", () => {
    const f = compile("width * 2");
    expect(f).toMatchObject({ deps: ["width"] });
    expect(run(f, record({ width: qty(1) }))).toEqual(qty(2));
    expect(run(compile("1 +"), EMPTY)).toMatchObject({ code: "#ERROR" });
  });
});
