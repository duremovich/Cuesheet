import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bestWindow, makeAnchor, reanchor, similarity } from "./anchorText";
import { parseScriptText } from "./extractText";

const v1 = parseScriptText(readFileSync("e2e/fixtures/script-v1.txt", "utf8"));
const v2 = parseScriptText(readFileSync("e2e/fixtures/script-v2.txt", "utf8"));

function find(text: typeof v1, s: string) {
  const b = text.blocks.find((x) => x.text.includes(s));
  if (!b) throw new Error(`no block with ${s}`);
  return { block: b.i, offset: b.text.indexOf(s), length: s.length };
}

describe("parseScriptText (the TXT stand-in)", () => {
  it("splits pages on form feeds with printed labels, and blocks by kind", () => {
    expect(v1.pages.map((p) => p.label)).toEqual(["12", "13", "14"]);
    expect(v1.source).toBe("txt");
    const kinds = v1.blocks.slice(0, 4).map((b) => b.kind);
    expect(kinds).toEqual(["heading", "direction", "character", "dialogue"]);
    expect(v1.blocks.every((b, i) => b.i === i)).toBe(true);
    expect(v1.blocks.find((b) => b.text === "SUE")?.kind).toBe("character");
  });
});

describe("makeAnchor", () => {
  it("keeps the quote with up to 32 characters of context, across blocks", () => {
    const at = find(v1, "Sweet Sue needs a sax and a bass");
    const a = makeAnchor(v1, at.block, at.offset, at.length);
    expect(a.quote).toBe("Sweet Sue needs a sax and a bass");
    expect(a.prefix.endsWith("Ladies, on the train! ")).toBe(true);
    expect(a.prefix.length).toBeLessThanOrEqual(32);
    expect(a.suffix.startsWith(", and she needs")).toBe(true);
  });
  it("makes positions (length 0) at a block start", () => {
    const a = makeAnchor(v1, 3, 0, 0);
    expect(a).toMatchObject({ block: 3, offset: 0, length: 0, quote: "" });
    expect(a.prefix.endsWith("\n")).toBe(true);
  });
});

describe("reanchor (the mock engine)", () => {
  it("matches, flags changed and missing lines between the fixture versions", () => {
    const q = (s: string) => {
      const at = find(v1, s);
      return makeAnchor(v1, at.block, at.offset, at.length);
    };
    const bien = find(v1, "Two uppers");
    const results = reanchor(v1, v2, [
      { cueId: "a", anchor: q("Sweet Sue needs a sax and a bass") },
      { cueId: "b", anchor: q("Josephine, tenor sax") },
      { cueId: "c", anchor: q("Try not to wake the drummer") },
      { cueId: "d", anchor: makeAnchor(v1, bien.block, 0, 0) },
    ]);
    expect(results.map((r) => r.state)).toEqual(["changed", "matched", "missing", "missing"]);
    const changed = results[0];
    expect(changed?.to?.quote).toBe("Sweet Sue needs a saxophone and a bass");
    expect(results[1]?.to?.block).toBe(find(v2, "Josephine").block);
  });

  it("scores similarity by word bigrams and finds the best stretch", () => {
    expect(similarity("a b c", "a b c")).toBe(1);
    expect(similarity("", "x")).toBe(0);
    const w = bestWindow("tenor sax", "Then Sweet Sue is in luck. Josephine, tenor sax.");
    expect(w.score).toBe(1);
  });
});
