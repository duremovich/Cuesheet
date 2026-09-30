import { describe, expect, it } from "vitest";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "../../lib/show-state";
import { planSortNow } from "./sortNow";

/** A show with cues in the given order: number or null; "#label" makes a section. */
function show(entries: (string | null)[]): { data: ShowData; ids: string[] } {
  const ids = entries.map(() => newId());
  const ops: Op[] = entries.map((e, i) => ({
    op: "create",
    table: "cues",
    id: ids[i] as string,
    fields: e?.startsWith("#") ? { is_section: true, description: e.slice(1) } : { number: e },
  }));
  const ctx = { userId: "u", now: 1 };
  const data = applyResolved(emptyData(), resolveLocal(emptyData(), ops, ctx));
  return { data, ids };
}

const labels = (data: ShowData) =>
  data.order.cues.map((id) => {
    const c = data.tables.cues.get(id);
    return c?.is_section ? `#${c.description}` : (c?.number ?? null);
  });

function apply(data: ShowData, ops: Op[]): ShowData {
  return applyResolved(data, resolveLocal(data, ops, { userId: "u", now: 2 }));
}

describe("planSortNow", () => {
  it("orders by number (decimals numerically) and replays to that order", () => {
    const { data } = show(["0.10", "0.30", "51.50", "1.00", "14.25", "14.2", "8.5A", "8.5"]);
    const cues = data.order.cues.map((id) => data.tables.cues.get(id) as never);
    const plan = planSortNow(cues);
    const after = apply(data, plan.ops);
    expect(labels(after)).toEqual([
      "0.10",
      "0.30",
      "1.00",
      "8.5",
      "8.5A",
      "14.2",
      "14.25",
      "51.50",
    ]);
    expect(after.order.cues).toEqual(plan.order);
    // The first two were already in place: only the rest moves.
    expect(plan.ops).toHaveLength(6);
    expect(
      plan.ops.every((o) => o.op === "move" && o.after === undefined && o.before === undefined),
    ).toBe(true);
    expect(plan.unnumbered).toBe(0);
  });

  it("puts unnumbered cues last in show order and counts them", () => {
    const { data } = show(["3", null, "1", "", "2"]);
    const cues = data.order.cues.map((id) => data.tables.cues.get(id) as never);
    const plan = planSortNow(cues);
    expect(plan.unnumbered).toBe(2);
    const after = apply(data, plan.ops);
    expect(labels(after)).toEqual(["1", "2", "3", null, ""]);
  });

  it("keeps a section directly above the numbered cue that followed it", () => {
    const { data } = show(["5", "#ACT 2", "20", "10", "#END"]);
    const cues = data.order.cues.map((id) => data.tables.cues.get(id) as never);
    const after = apply(data, planSortNow(cues).ops);
    expect(labels(after)).toEqual(["5", "10", "#ACT 2", "20", "#END"]);
  });

  it("is a no-op when already sorted, and ties keep show order", () => {
    const { data, ids } = show(["1", "2", "2.0", "3"]);
    const cues = data.order.cues.map((id) => data.tables.cues.get(id) as never);
    const plan = planSortNow(cues);
    expect(plan.ops).toEqual([]);
    expect(plan.order).toEqual(ids);
  });

  it("keeps order keys short (moves append to the end)", () => {
    const n = 300;
    const { data } = show(Array.from({ length: n }, (_, i) => String(n - i)));
    const cues = data.order.cues.map((id) => data.tables.cues.get(id) as never);
    const after = apply(data, planSortNow(cues).ops);
    expect(labels(after)).toEqual(Array.from({ length: n }, (_, i) => String(i + 1)));
    const longest = Math.max(...[...after.tables.cues.values()].map((c) => c.order_key.length));
    expect(longest).toBeLessThanOrEqual(4);
  });
});
