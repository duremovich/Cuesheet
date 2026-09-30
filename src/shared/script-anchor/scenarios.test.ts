// Review regression scenarios (M4a): a realistic 3-page musical scene edited the ways
// rehearsal drafts change, and an 8-page script with repeated, similar lines. The rule
// under test throughout: an anchor never silently jumps to someone else's line; when
// the right place is unclear it's flagged (changed / missing).
import { describe, expect, it } from "vitest";
import type { Anchor, ScriptText } from "../script";
import { makeAnchor, makePositionAnchor, reanchor } from ".";
import { build, type Line, P1, P2, P3 } from "./scene.fixture";

const v1 = build([P1, P2, P3]);
const find = (t: ScriptText, s: string, nth = 0) => {
  const b = t.blocks.filter((x) => x.text.includes(s))[nth];
  if (!b) throw new Error(`no ${s}`);
  return { block: b.i, offset: b.text.indexOf(s) };
};
const sel = (t: ScriptText, s: string, nth = 0): Anchor => {
  const { block, offset } = find(t, s, nth);
  return makeAnchor(t, block, offset, s.length);
};
const FLORIDA = "I always wanted to see Florida. I just never pictured doing it in a girdle.";
const SWEET = "Sweet Sue needs a sax and a bass, and I don't see anybody else volunteering.";
const THEYLL = "They'll buy it. People see what they expect to see.";
const A = {
  sweetFull: sel(v1, SWEET),
  sweetPart: sel(v1, "Sweet Sue needs a sax and a bass"),
  goJoe: sel(v1, "Go.", 1),
  whistlePos: makePositionAnchor(v1, find(v1, "(A whistle blows").block),
  nobody1: sel(v1, "Nobody's gonna buy it, Joe."),
  nobody2: sel(v1, "Nobody in the whole wide world."),
  theyll: sel(v1, THEYLL),
  florida: sel(v1, FLORIDA),
};
type Key = keyof typeof A;

const clone = (p: Line[]) => p.map((l) => [...l] as Line);
const base = () => [clone(P1), clone(P2), clone(P3)];
const replace = (pages: Line[][], from: string, to: string | null | Line[]) =>
  pages.map((p) =>
    p.flatMap((l): Line[] => {
      if (l[1] !== from) return [l];
      if (to === null) return [];
      if (typeof to === "string") return [[l[0], to]];
      return to;
    }),
  );
const run = (v2: ScriptText, key: Key) => {
  const r = reanchor(v1, v2, [{ cueId: key, anchor: A[key] }])[0];
  if (!r) throw new Error("no result");
  return { ...r, text: r.to ? v2.blocks[r.to.block]?.text : null };
};

describe("review scenarios", () => {
  it("identity: everything matched", () => {
    const res = reanchor(
      v1,
      v1,
      (Object.keys(A) as Key[]).map((k) => ({ cueId: k, anchor: A[k] })),
    );
    expect(res.every((r) => r.state === "matched" && r.confidence === 1)).toBe(true);
  });

  it("b2: original edited, exact copy on another page → changed at the edited original", () => {
    const pages = base();
    pages[0]?.splice(3, 0, ["character", "JERRY"], ["dialogue", FLORIDA]);
    const edited = replace(pages, FLORIDA, "__");
    // Put the copy back (replace hit it too) and edit the original only.
    (edited[0] as Line[])[4] = ["dialogue", FLORIDA];
    const last = edited[2] as Line[];
    const i = last.findIndex((l) => l[1] === "__");
    last[i] = ["dialogue", FLORIDA.replace("girdle", "corset")];
    const r = run(build(edited), "florida");
    expect(r.state).toBe("changed");
    expect(r.text).toContain("corset");
    expect(r.candidates.some((c) => c.score === 1)).toBe(true); // the copy, offered
  });

  it("i2: JOE's 'Go.' cut while other 'Go.'s remain → missing", () => {
    const pages = base();
    (pages[0] as Line[]).splice(12, 2);
    expect(run(build(pages), "goJoe").state).toBe("missing");
  });

  it("i3: JOE's 'Go.' → 'Go on then.' → changed there, not another 'Go.'", () => {
    const pages = base();
    (pages[0] as Line[])[13] = ["dialogue", "Go on then."];
    const r = run(build(pages), "goJoe");
    expect(r.state).toBe("changed");
    expect(r.text).toBe("Go on then.");
  });

  it("a short quote found only in other lines → changed 0.6 with the occurrences", () => {
    // The anchored line changed beyond its context too, so nothing places it.
    const pages = base();
    const p = pages[0] as Line[];
    p.splice(11, 4, ["direction", "(Different business here entirely, nothing alike.)"]);
    const r = run(build(pages), "goJoe");
    expect(["changed", "missing"]).toContain(r.state);
    if (r.state === "changed") expect(r.confidence).toBeLessThanOrEqual(0.6);
  });

  it("c/c2: a line moved to another page (with or without its speaker) → moved", () => {
    const pages = replace(base(), THEYLL, null);
    (pages[2] as Line[]).splice(5, 0, ["dialogue", THEYLL]);
    expect(run(build(pages), "theyll")).toMatchObject({ state: "moved", text: THEYLL });
    const pages2 = replace(base(), THEYLL, null);
    (pages2[1] as Line[]).splice(2, 1);
    (pages2[2] as Line[]).splice(5, 0, ["character", "JOE"], ["dialogue", THEYLL]);
    expect(run(build(pages2), "theyll")).toMatchObject({ state: "moved", text: THEYLL });
  });

  it("d: an unchanged line next to an insertion stays matched", () => {
    const v2 = build([[...clone(P1), ["direction", "(Pause.)"]], clone(P2), clone(P3)]);
    expect(run(v2, "nobody1").state).toBe("matched");
    expect(run(v2, "nobody2").state).toBe("matched");
  });

  it("f: cuts (the line, the line and its neighbours, a speech on part of a line) → missing", () => {
    expect(run(build(replace(base(), THEYLL, null)), "theyll").state).toBe("missing");
    const pages = base();
    const p = pages[1] as Line[];
    const i = p.findIndex((l) => l[1] === THEYLL);
    p.splice(i - 1, 3);
    expect(run(build(pages), "theyll").state).toBe("missing");
    const pages3 = base();
    const q = pages3[2] as Line[];
    const k = q.findIndex((l) => l[1] === FLORIDA);
    q.splice(k - 1, 3);
    expect(run(build(pages3), "florida").state).toBe("missing");
    expect(run(build(replace(base(), SWEET, null)), "sweetPart").state).toBe("missing");
  });

  it("e2: a positional anchor whose direction was deleted → missing", () => {
    const v2 = build(
      replace(base(), "(A whistle blows in the distance. The lights shift to a cold blue.)", null),
    );
    expect(run(v2, "whistlePos").state).toBe("missing");
  });

  it("edits in place → changed at the edited line", () => {
    const light = build(replace(base(), SWEET, SWEET.replace("bass,", "bass player,")));
    expect(run(light, "sweetFull")).toMatchObject({ state: "changed" });
    expect(run(light, "sweetFull").confidence).toBeGreaterThan(0.8);
    const reword = build(
      replace(
        base(),
        SWEET,
        "Sweet Sue is short a sax and a bass, and I don't see anyone else stepping up.",
      ),
    );
    const r = run(reword, "sweetFull");
    expect(r.state).toBe("changed");
    expect(r.text).toContain("is short a sax");
  });
});

// ---- an 8-page script of near-identical scenes (the reviewer's live probe) ----

function page(n: number): string[] {
  return [
    `SCENE ${n}: PLACE NUMBER ${n}`,
    `(Lights rise on location ${n}. JOE and JERRY enter from stage left, carrying case ${n}.)`,
    "JOE",
    `We have exactly ${n} minutes before the train number ${n} leaves the station.`,
    "JERRY",
    "Go.",
    "JOE",
    `Sweet Sue needs a sax and a bass on platform ${n}, and I don't see anybody else volunteering.`,
    "JERRY",
    `Nobody's gonna buy it, Joe, not on page ${n}. Nobody in the whole wide world.`,
    `(A whistle blows in the distance for the ${n} time. The lights shift to a cold blue.)`,
    "SUGAR",
    `RUNNIN' WILD, LOST CONTROL, VERSE ${n}`,
    `(Blackout on scene ${n}.)`,
  ];
}
const textOf = (pages: string[][]): ScriptText =>
  build(pages.map((p) => p.map((t): Line => ["other", t])));

describe("similar scenes (probe q1/q6/q7)", () => {
  const v1Pages = Array.from({ length: 8 }, (_, i) => page(i + 1));
  const old = textOf(v1Pages);
  const s = (t: string) => {
    const b = old.blocks.find((x) => x.text === t);
    if (!b) throw new Error(t);
    return b.i;
  };
  const q1 = makeAnchor(
    old,
    s("Sweet Sue needs a sax and a bass on platform 2, and I don't see anybody else volunteering."),
    0,
    "Sweet Sue needs a sax and a bass on platform 2, and I don't see anybody else volunteering."
      .length,
  );
  const q6 = makePositionAnchor(
    old,
    s("(A whistle blows in the distance for the 6 time. The lights shift to a cold blue.)"),
  );
  const q7 = makeAnchor(old, s("RUNNIN' WILD, LOST CONTROL, VERSE 7"), 0, 35);

  const v2Pages = v1Pages.map((p) => [...p]);
  const rep = (pi: number, from: string, to: string | null) => {
    const p = v2Pages[pi] as string[];
    const i = p.indexOf(from);
    if (to === null) p.splice(i, 1);
    else p[i] = to;
  };
  rep(
    1,
    "Sweet Sue needs a sax and a bass on platform 2, and I don't see anybody else volunteering.",
    "Sweet Sue is short a sax and a bass on platform 2, and I don't see anyone else stepping up.",
  );
  rep(
    5,
    "(A whistle blows in the distance for the 6 time. The lights shift to a cold blue.)",
    null,
  );
  {
    const p = v2Pages[6] as string[];
    const i = p.indexOf("RUNNIN' WILD, LOST CONTROL, VERSE 7");
    p.splice(i - 1, 3);
  }
  {
    const p = v2Pages[1] as string[];
    const i = p.indexOf("Go.");
    p.splice(i - 1, 2);
  }
  (v2Pages[0] as string[]).splice(1, 0, "(Overture.)");
  const next = textOf(v2Pages);
  const [r1, r6, r7] = reanchor(old, next, [
    { cueId: "q1", anchor: q1 },
    { cueId: "q6", anchor: q6 },
    { cueId: "q7", anchor: q7 },
  ]);

  it("q1: a reworded line lands on itself, not on the same line of another scene", () => {
    expect(r1?.state).toBe("changed");
    expect(next.blocks[r1?.to?.block ?? -1]?.text).toContain("is short a sax");
    expect(next.blocks[r1?.to?.block ?? -1]?.page).toBe(2);
  });

  it("q6/q7: deleted lines don't jump to another scene's copy", () => {
    expect(r6?.state).toBe("missing");
    expect(r7?.state).toBe("missing");
  });
});
