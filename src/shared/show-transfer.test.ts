import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  chunkRows,
  diffDigests,
  mapMemberships,
  referencedIds,
  remapIds,
} from "./show-transfer";

const A = "0195f0a0-0000-7000-8000-00000000000a";
const B = "0195f0a0-0000-7000-8000-00000000000b";
const ADMIN = "0195f0a0-0000-7000-8000-0000000000ad";

describe("remapIds", () => {
  it("replaces ids everywhere, including inside JSON-in-a-string columns", () => {
    const row = {
      created_by: A,
      custom: JSON.stringify({ people: [A, B] }),
      old: JSON.stringify(JSON.stringify({ owner_user_id: A })),
    };
    const out = JSON.parse(remapIds(JSON.stringify(row), new Map([[A, ADMIN]])));
    expect(out.created_by).toBe(ADMIN);
    expect(JSON.parse(out.custom)).toEqual({ people: [ADMIN, B] });
    expect(JSON.parse(JSON.parse(out.old))).toEqual({ owner_user_id: ADMIN });
  });

  it("refuses short ids (they could match inside other values)", () => {
    expect(() => remapIds("x", new Map([["1", "2"]]))).toThrow(/short id/);
    expect(remapIds("1", new Map([["1", "1"]]))).toBe("1");
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("chunkRows", () => {
  it("keeps every row, in order, under the size (one oversized row gets its own chunk)", () => {
    const rows = [{ v: "x".repeat(40) }, { v: "y".repeat(40) }, { v: "z".repeat(300) }, { v: "w" }];
    const chunks = chunkRows(rows, 100);
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.map((c) => c.length)).toEqual([2, 1, 1]);
    for (const c of chunks)
      if (c.length > 1) expect(JSON.stringify(c).length).toBeLessThanOrEqual(100);
    expect(chunkRows(rows, 10_000)).toEqual([rows]);
    expect(chunkRows([], 100)).toEqual([]);
  });
});

describe("mapMemberships", () => {
  it("merges users mapped onto one account: highest role, earliest date", () => {
    const rows = [
      { show_id: "s", user_id: A, role: "viewer", created_at: 5 },
      { show_id: "s", user_id: ADMIN, role: "editor", created_at: 9 },
      { show_id: "s", user_id: B, role: "owner", created_at: 7 },
    ];
    const out = mapMemberships(
      rows,
      new Map([
        [A, ADMIN],
        [B, ADMIN],
      ]),
    );
    expect(out).toEqual([{ show_id: "s", user_id: ADMIN, role: "owner", created_at: 5 }]);
  });

  it("keeps unmapped users as they are", () => {
    const rows = [{ show_id: "s", user_id: A, role: "editor", created_at: 1 }];
    expect(mapMemberships(rows, new Map())).toEqual(rows);
  });
});

describe("referencedIds / diffDigests", () => {
  it("finds which ids occur", () => {
    expect([...referencedIds(`{"x":"${A}"}`, [A, B])]).toEqual([A]);
  });

  it("reports missing tables, counts and content", () => {
    const d = (rows: number, sha256: string) => ({ rows, sha256 });
    expect(diffDigests({ a: d(1, "x") }, { a: d(1, "x") })).toEqual([]);
    expect(
      diffDigests(
        { a: d(1, "x"), b: d(2, "y"), c: d(1, "z") },
        { a: d(1, "q"), c: d(3, "z"), e: d(0, "") },
      ),
    ).toEqual([
      "table a: same row count, different content",
      "table b: missing on the target",
      "table c: 1 rows on source, 3 on target",
      "table e: only on the target",
    ]);
  });
});
