import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { compareOrder, keysAfter, orderKeyFor, PlacementError } from "./order";

const rows = (...keys: string[]) => keys.map((k, i) => ({ id: `id${i}`, order_key: k }));

describe("orderKeyFor", () => {
  const list = rows("a0", "a1", "a2");

  it("appends, prepends and inserts between neighbours", () => {
    expect(orderKeyFor([], {})).toBe("a0");
    const end = orderKeyFor(list, {});
    expect(end > "a2").toBe(true);
    const start = orderKeyFor(list, { after: null });
    expect(start < "a0").toBe(true);
    const mid = orderKeyFor(list, { after: "id0" });
    expect(mid > "a0" && mid < "a1").toBe(true);
    const before = orderKeyFor(list, { before: "id2" });
    expect(before > "a1" && before < "a2").toBe(true);
    const both = orderKeyFor(list, { after: "id0", before: "id1" });
    expect(both > "a0" && both < "a1").toBe(true);
  });

  it("ignores the moved row itself", () => {
    // Moving id0 after id2: neighbours are id2 and nothing.
    expect(orderKeyFor(list, { after: "id2" }, "id0") > "a2").toBe(true);
    // Moving id1 to the start: the first other row is id0.
    expect(orderKeyFor(list, { after: null }, "id1") < "a0").toBe(true);
  });

  it("never lands on a key already in use when neighbours tie", () => {
    const tied = rows("a0", "a1", "a1", "a2");
    const k = orderKeyFor(tied, { after: "id1" });
    expect(k > "a1" && k < "a2").toBe(true);
    const k2 = orderKeyFor(tied, { before: "id2" });
    expect(k2 > "a0" && k2 < "a1").toBe(true);
  });

  it("throws PlacementError for unknown neighbours", () => {
    expect(() => orderKeyFor(list, { after: "nope" })).toThrow(PlacementError);
    expect(() => orderKeyFor(list, { before: "nope" })).toThrow(PlacementError);
  });

  it("keysAfter makes increasing keys", () => {
    const keys = keysAfter("a5", 50);
    expect(keys).toHaveLength(50);
    expect([...keys].sort()).toEqual(keys);
    expect((keys[0] as string) > "a5").toBe(true);
  });
});

describe("compareOrder", () => {
  it("sorts by key then id, byte-wise", () => {
    const sorted = [
      { id: "b", order_key: "a1" },
      { id: "a", order_key: "a1" },
      { id: "c", order_key: "Zz" },
    ].sort(compareOrder);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("newId", () => {
  it("makes UUIDv7s that increase", () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(200);
  });
});
