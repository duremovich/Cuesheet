import { describe, expect, it } from "vitest";
import {
  type Anchor,
  buildPageMap,
  normalizeText,
  pageForBlock,
  sanitizeScriptText,
} from "../script";
import {
  anchorPosition,
  anchorStats,
  diffPages,
  FUZZY_THRESHOLD,
  joinBlocks,
  makeAnchor,
  makePositionAnchor,
  mapBlocks,
  reanchor,
  suggestSlot,
} from ".";
import { lines, rng, script } from "./testing";

const base = lines(300, 7);
const old = script(base);

/** Anchor on a whole block (the usual "select the line" case). */
const onBlock = (b: number): Anchor => makeAnchor(old, b, 0, (base[b] as string).length);
/** Anchor on a phrase inside a block: words [from, to). */
const onWords = (b: number, from: number, to: number): Anchor => {
  const words = (base[b] as string).split(" ");
  const offset = words.slice(0, from).join(" ").length + (from > 0 ? 1 : 0);
  const length = words.slice(from, to).join(" ").length;
  return makeAnchor(old, b, offset, length);
};
const one = (next: ReturnType<typeof script>, anchor: Anchor) =>
  reanchor(old, next, [{ cueId: "q", anchor }])[0] as ReturnType<typeof reanchor>[number];

describe("normalizeText", () => {
  it("straightens quotes and dashes, collapses whitespace and NBSP, NFKC", () => {
    expect(normalizeText("“Sweet Sue” — she’s  here now… ")).toBe(
      '"Sweet Sue" - she\'s here now...',
    );
    expect(normalizeText("ﬁne­​ line\n\tbreak – −")).toBe("fine line break - -");
    expect(normalizeText("  ‘a’  ")).toBe("'a'");
  });
});

describe("anchors", () => {
  it("makeAnchor computes quote and ≤ 32 characters of context", () => {
    const a = onWords(10, 2, 5);
    const j = joinBlocks(old);
    expect(a.block).toBe(10);
    expect(a.quote).toBe((base[10] as string).split(" ").slice(2, 5).join(" "));
    expect(a.prefix.length).toBe(32);
    expect(a.suffix.length).toBe(32);
    expect(j.text.slice(j.starts[10] as number).startsWith((base[10] as string).slice(0, 5))).toBe(
      true,
    );
    expect(() => makeAnchor(old, 999, 0, 1)).toThrow(RangeError);
    expect(() => makeAnchor(old, 1, 9999, 1)).toThrow(RangeError);
  });

  it("anchorPosition splits a selection across blocks into segments", () => {
    const len = (base[4] as string).length;
    const a = makeAnchor(old, 4, len - 5, 5 + 1 + 6); // last 5 chars, the separator, 6 more
    const pos = anchorPosition(old, a);
    expect(pos?.segments).toEqual([
      { block: 4, start: len - 5, end: len },
      { block: 5, start: 0, end: 6 },
    ]);
    expect(pos?.exact).toBe(true);
    expect(pos?.label).toBe("1");
    expect(anchorPosition(old, { ...a, block: 1000 })).toBeNull();
  });

  it("makePositionAnchor quotes the block's first words", () => {
    const a = makePositionAnchor(old, 3);
    expect(a.offset).toBe(0);
    expect(a.quote.length).toBeLessThanOrEqual(48);
    expect((base[3] as string).startsWith(a.quote)).toBe(true);
  });

  it("suggestSlot puts a positional cue after the previous cue's anchor", () => {
    expect(suggestSlot(old, { before: onBlock(10), after: onBlock(20) })).toBe(11);
    expect(suggestSlot(old, { before: onBlock(10), after: onBlock(10) })).toBe(10);
    expect(suggestSlot(old, { after: onBlock(20) })).toBe(20);
    expect(suggestSlot(old, {})).toBe(0);
    expect(suggestSlot(old, { before: onBlock(299) })).toBe(299);
  });
});

describe("page map", () => {
  it("maps blocks to pages and labels", () => {
    const t = script(base, 30, (p) => (p === 3 ? "2a" : String(p)));
    const map = buildPageMap(t);
    expect(map).toHaveLength(10);
    expect(pageForBlock(map, 0)).toEqual({ startBlock: 0, page: 1, label: "1" });
    expect(pageForBlock(map, 65)).toEqual({ startBlock: 60, page: 3, label: "2a" });
    expect(pageForBlock(map, 299)?.page).toBe(10);
  });

  it("sanitizeScriptText normalizes, renumbers and drops empty blocks", () => {
    const r = sanitizeScriptText({
      source: "txt",
      confidence: 3,
      blocks: [
        { i: 9, page: 1, kind: "dialogue", text: "  Hello  there " },
        { i: 3, page: 1, kind: "bogus", text: "   " },
        { i: 4, page: 2, kind: "heading", text: "ACT ONE" },
      ],
      pages: [{ page: 2, label: "14a" }],
    });
    expect(r).toEqual({
      text: {
        blocks: [
          { i: 0, page: 1, kind: "dialogue", text: "Hello there" },
          { i: 1, page: 2, kind: "heading", text: "ACT ONE" },
        ],
        pages: [
          { page: 1, label: "1" },
          { page: 2, label: "14a" },
        ],
        source: "txt",
        confidence: 1,
      },
    });
    expect(sanitizeScriptText({ source: "txt", blocks: [] })).toEqual({
      error: "The script has no text",
    });
    expect("error" in sanitizeScriptText({ source: "rtf", blocks: [] })).toBe(true);
    expect(
      "error" in
        sanitizeScriptText({
          source: "txt",
          blocks: [
            { page: 2, text: "b" },
            { page: 1, text: "a" },
          ],
        }),
    ).toBe(true);
  });
});

describe("mapBlocks / diffPages", () => {
  it("pairs identical blocks across inserts and deletes", () => {
    const next = [...base.slice(0, 40), "New line one.", "New line two.", ...base.slice(41)];
    const map = mapBlocks(old, script(next));
    expect(map[39]).toBe(39);
    expect(map[40]).toBe(-1); // deleted
    expect(map[41]).toBe(42);
    expect(map[299]).toBe(300);
  });

  it("summarises pages", () => {
    const next = [...base.slice(0, 40), "New line one.", ...base.slice(40)];
    const d = diffPages(old, script(next));
    expect(d.blocksInserted).toBe(1);
    expect(d.blocksDeleted).toBe(0);
    expect(d.pages[0]?.status).toBe("same");
    expect(d.pages[1]?.status).toBe("changed");
    expect(d.pages.at(-1)?.status).toBe("same"); // repaginated, text unchanged
    expect(d.removed).toBe(0);
    const rewritten = diffPages(old, script([...base.slice(0, 270), ...lines(30, 42)]));
    expect(rewritten.pages.at(-1)?.status).toBe("new");
    expect(rewritten.removed).toBe(1);
  });
});

describe("reanchor", () => {
  it("identical text: everything matched with confidence 1", () => {
    const anchors = [5, 50, 150, 299].map((b) => ({ cueId: `c${b}`, anchor: onBlock(b) }));
    const res = reanchor(old, script([...base]), anchors);
    expect(res.map((r) => r.state)).toEqual(["matched", "matched", "matched", "matched"]);
    expect(res.every((r) => r.confidence === 1 && r.to?.block === r.from.block)).toBe(true);
    expect(res[0]?.to).toEqual(anchors[0]?.anchor);
    expect(anchorStats(res)).toMatchObject({ matched: 4, moved: 0, changed: 0, missing: 0 });
  });

  it("inserted paragraphs: matched on the same page, moved when pushed to another", () => {
    const inserted = ["INSERTED ONE.", "Inserted two here.", "Inserted three, a longer one."];
    const next = script([...base.slice(0, 30), ...inserted, ...base.slice(30)]);
    const early = one(next, onWords(5, 1, 4));
    expect(early.state).toBe("matched");
    expect(early.to?.block).toBe(5);
    const pushed = one(next, onBlock(58)); // page 2 → block 61, page 3
    expect(pushed.state).toBe("moved");
    expect(pushed.to?.block).toBe(61);
    expect(pushed.confidence).toBe(1);
    const same = one(next, onBlock(40)); // page 2 → block 43, still page 2
    expect(same.state).toBe("matched");
    expect(same.to?.block).toBe(43);
  });

  it("reflowed into different blocks and pages: the joined text still matches", () => {
    // Each line split in two at a space; 20 blocks per page.
    const split = base.flatMap((l) => {
      const words = l.split(" ");
      const h = Math.ceil(words.length / 2);
      return [words.slice(0, h).join(" "), words.slice(h).join(" ")];
    });
    const res = reanchor(old, script(split, 20), [
      { cueId: "a", anchor: onBlock(100) },
      { cueId: "b", anchor: onWords(3, 0, 3) },
    ]);
    expect(res[0]?.state).toBe("moved");
    expect(res[0]?.to?.block).toBe(200);
    expect(res[0]?.to?.quote).toBe(base[100]);
    expect(res[0]?.to?.length).toBe((base[100] as string).length); // spans two new blocks
    expect(res[1]?.state).toBe("matched"); // same page ("1"), nearby block
    expect(res[1]?.to?.block).toBe(6);
  });

  it("deleted anchored line → missing", () => {
    const next = script([...base.slice(0, 120), ...base.slice(121)]);
    const r = one(next, onBlock(120));
    expect(r.state).toBe("missing");
    expect(r.to).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    expect(r.candidates.every((c) => c.score < FUZZY_THRESHOLD)).toBe(true);
  });

  it("one word edited → changed, at the edited line, confidence = similarity", () => {
    const words = (base[80] as string).split(" ");
    words[2] = "zebra";
    const next = script([...base.slice(0, 80), words.join(" "), ...base.slice(81)]);
    const r = one(next, onBlock(80));
    expect(r.state).toBe("changed");
    expect(r.to?.block).toBe(80);
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(r.confidence).toBeLessThan(1);
    expect(r.candidates[0]?.anchor).toEqual(r.to);
  });

  it("half the words rewritten → changed by context (0.5), with fuzzy candidates", () => {
    const r0 = rng(99);
    const words = (base[200] as string)
      .split(" ")
      .map((w, i) => (i % 2 === 0 ? `x${Math.floor(r0() * 1e6).toString(36)}` : w));
    const rewritten = words.join(" ");
    const next = script([...base.slice(0, 200), rewritten, ...base.slice(201)]);
    const r = one(next, onBlock(200));
    expect(r.state).toBe("changed");
    expect(r.confidence).toBe(0.5);
    expect(r.to?.block).toBe(200);
    expect(r.to?.quote).toBe(rewritten);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("rewritten beyond recognition with its context gone → missing", () => {
    const next = script([
      ...base.slice(0, 199),
      "Completely different preceding line.",
      "Nothing like the original at all.",
      "Also a brand new following line.",
      ...base.slice(202),
    ]);
    expect(one(next, onBlock(200)).state).toBe("missing");
  });

  it("duplicate lines: context picks the right one; without context, the nearest", () => {
    const refrain = "Runnin' wild, lost control.";
    const dup = [...base];
    dup[20] = refrain;
    dup[250] = refrain;
    const before = script(dup);
    const anchor = makeAnchor(before, 250, 0, refrain.length);
    // Unchanged: the context finds block 250, not 20.
    const same = reanchor(before, script([...dup]), [{ cueId: "q", anchor }])[0];
    expect(same?.state).toBe("matched");
    expect(same?.to?.block).toBe(250);
    // Both neighbours of both copies edited: the quote alone, nearest the prediction.
    const edited = [...dup];
    for (const i of [19, 21, 249, 251]) edited[i] = `Edited ${i} line with new words.`;
    const r = reanchor(before, script(edited), [{ cueId: "q", anchor }])[0];
    expect(r?.state).toBe("moved");
    expect(r?.confidence).toBe(0.9);
    expect(r?.to?.block).toBe(250);
  });

  it("positional anchors follow their block", () => {
    const next = script(["A new first line.", ...base]);
    const r = one(next, makePositionAnchor(old, 42));
    expect(r.state).toBe("matched");
    expect(r.to?.block).toBe(43);
  });

  it("an anchor with no known position is still found", () => {
    const a = { ...onBlock(77), block: -1, offset: 0 };
    const r = one(script([...base]), a);
    expect(r.to?.block).toBe(77);
    expect(r.state).toBe("moved");
  });

  it("smart quotes and dashes in the quote match straight ones in the text", () => {
    const withQuote = [...base];
    withQuote[60] = `He said "go" - and she's gone.`;
    const t = script(withQuote);
    const a = makeAnchor(t, 60, 0, (withQuote[60] as string).length);
    const curly = { ...a, quote: "He said “go” — and she’s gone." };
    const r = reanchor(t, t, [{ cueId: "q", anchor: curly }])[0];
    expect(r?.state).toBe("matched");
  });

  it("is deterministic", () => {
    const next = script([
      ...base.slice(0, 100),
      "Inserted.",
      ...base.slice(100, 180),
      ...base.slice(182),
    ]);
    const anchors = [10, 99, 100, 150, 180, 181, 250].map((b) => ({
      cueId: `c${b}`,
      anchor: onBlock(b),
    }));
    expect(reanchor(old, next, anchors)).toEqual(reanchor(old, next, anchors));
  });
});

describe("performance", () => {
  it("1,500 blocks × 150 anchors re-anchor in under 300 ms", () => {
    const big = lines(1500, 3);
    const before = script(big, 12);
    const r = rng(5);
    // Edits: inserts, deletes and word changes spread through the script.
    const after: string[] = [];
    big.forEach((l, i) => {
      const x = r();
      if (x < 0.02) return; // deleted
      if (x < 0.05) after.push(`${l.split(" ").slice(0, -2).join(" ")} changed words.`);
      else after.push(l);
      if (r() < 0.03) after.push("An inserted line of dialogue appears here.");
      if (i === 700) after.push(...lines(40, 11));
    });
    const next = script(after, 11);
    const anchors = Array.from({ length: 150 }, (_, k) => {
      const b = k * 10;
      const len = (big[b] as string).length;
      return { cueId: `c${k}`, anchor: makeAnchor(before, b, 0, Math.min(len, 40)) };
    });
    reanchor(before, next, anchors.slice(0, 5)); // warm up the JIT
    const t0 = performance.now();
    const res = reanchor(before, next, anchors);
    const ms = performance.now() - t0;
    const stats = anchorStats(res);
    expect(stats.matched + stats.moved).toBeGreaterThan(120);
    expect(ms).toBeLessThan(300);
  });
});
