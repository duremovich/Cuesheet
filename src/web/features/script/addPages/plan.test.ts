import { describe, expect, it } from "vitest";
import {
  actionText,
  type BasePage,
  buildPlan,
  checkPlan,
  defaultVersionLabel,
  type IncomingPage,
  mergeOrder,
  type Plan,
} from "./plan";

const base = (labels: (string | null)[]): BasePage[] =>
  labels.map((label, index) => ({ index, label }));

const incoming = (labels: (string | null)[], file = 0): IncomingPage[] =>
  labels.map((label, index) => ({
    key: `${file}:${index}`,
    file,
    index,
    fileName: `new-${file}.pdf`,
    label,
    firstLine: "",
  }));

const B = base(["1", "2", "13", "13a", "14", "68-69", "70", "138", "139", "139a", "140"]);
const at = (label: string) => B.findIndex((p) => p.label === label);

describe("Add pages: plan", () => {
  it("replaces existing labels and inserts new ones in label order", () => {
    const plan = buildPlan(B, incoming(["138", "139b", "13b", "141"]));
    expect(plan.rows.map((r) => actionText(B, r.action))).toEqual([
      "Replace 138",
      "Insert after 139a",
      "Insert after 13a",
      "Insert after 140",
    ]);
    expect(checkPlan(B, plan).ok).toBe(true);
  });

  it("combined labels: 45-46 replaces both; 68 alone replaces the base's 68-69 (with a warning)", () => {
    const b = base(["44", "45", "46", "47", "68-69", "70"]);
    const plan = buildPlan(b, incoming(["45-46", "68"]));
    expect(plan.rows.map((r) => actionText(b, r.action))).toEqual([
      "Replace 45, 46",
      "Replace 68-69",
    ]);
    const check = checkPlan(b, plan);
    expect(check.ok).toBe(true);
    expect(check.rowWarnings.get("0:1")).toMatch(/page 69 isn't in the new pages/);
    // 68 and 69 together cover it: no warning, both land in its place, in order.
    const both = buildPlan(b, incoming(["69", "68"]));
    expect(checkPlan(b, both).rowWarnings.size).toBe(0);
    expect(mergeOrder(b.length, both)).toEqual([
      { src: "base", index: 0 },
      { src: "base", index: 1 },
      { src: "base", index: 2 },
      { src: "base", index: 3 },
      { src: "in", file: 0, index: 1 },
      { src: "in", file: 0, index: 0 },
      { src: "base", index: 5 },
    ]);
    // The base's combined page replaced by the same combined label.
    expect(
      actionText(b, buildPlan(b, incoming(["68-69"])).rows[0]?.action ?? { kind: "skip" }),
    ).toBe("Replace 68-69");
  });

  it("unlabeled pages and pages before everything need a choice; Apply waits for it", () => {
    const plan = buildPlan(B, incoming([null, "0a"]));
    expect(plan.rows.map((r) => r.action.kind)).toEqual(["choose", "choose"]);
    expect(plan.rows[0]?.why).toBe("No page label found.");
    const check = checkPlan(B, plan);
    expect(check.ok).toBe(false);
    expect(check.rowErrors.get("0:0")).toBe("Choose what to do with this page.");
    const chosen: Plan = {
      ...plan,
      rows: plan.rows.map((r, k) => ({
        ...r,
        action: k === 0 ? { kind: "insert", after: -1 } : { kind: "skip" },
      })),
    };
    expect(checkPlan(B, chosen).ok).toBe(true);
    expect(mergeOrder(B.length, chosen)[0]).toEqual({ src: "in", file: 0, index: 0 });
    expect(actionText(B, { kind: "insert", after: -1 })).toBe("Insert before 1");
  });

  it("flags two incoming pages with the same label until one is skipped", () => {
    const plan: Plan = {
      rows: [...incoming(["138"], 0), ...incoming(["138"], 1)].map((page) => ({
        page,
        action: { kind: "replace", targets: [at("138")] },
      })),
      removed: [],
    };
    const check = checkPlan(B, plan);
    expect(check.ok).toBe(false);
    expect(check.rowErrors.get("0:0")).toMatch(/2 incoming pages are labelled 138/);
    expect(check.rowErrors.get("1:0")).toMatch(/2 incoming pages are labelled 138/);
    const skipped: Plan = {
      ...plan,
      rows: plan.rows.map((r, k) => (k === 0 ? { ...r, action: { kind: "skip" } } : r)),
    };
    expect(checkPlan(B, skipped).ok).toBe(true);
  });

  it("removals: dropped from the merge; a page both replaced and removed is refused; nothing to do is refused", () => {
    expect(checkPlan(B, { rows: [], removed: [] }).errors).toEqual(["Nothing to change yet."]);
    const cut: Plan = { rows: [], removed: [at("13a")] };
    expect(checkPlan(B, cut).ok).toBe(true);
    expect(mergeOrder(B.length, cut).map((r) => B[r.index]?.label)).toEqual(
      B.map((p) => p.label).filter((l) => l !== "13a"),
    );
    const clash: Plan = { ...buildPlan(B, incoming(["138"])), removed: [at("138")] };
    expect(checkPlan(B, clash).rowErrors.get("0:0")).toMatch(/138 is also in “Remove pages”/);
  });

  it("merge order: replacement in place, inserts after their page in label order, removal", () => {
    const pages = incoming(["139c", "138", "139b", "140"]);
    const plan: Plan = { ...buildPlan(B, pages), removed: [at("2")] };
    const order = mergeOrder(B.length, plan);
    const name = (r: (typeof order)[number]) =>
      r.src === "base" ? `${B[r.index]?.label}` : `new ${pages[r.index]?.label}`;
    expect(order.map(name)).toEqual([
      "1",
      "13",
      "13a",
      "14",
      "68-69",
      "70",
      "new 138",
      "139",
      "139a",
      "new 139b",
      "new 139c",
      "new 140",
    ]);
  });

  it("suggests a version label from the pages, in order", () => {
    const plan: Plan = { ...buildPlan(B, incoming(["140", "138", "139b"])), removed: [at("13a")] };
    expect(defaultVersionLabel(B, plan)).toBe("Pages 138, 139b, 140 (removed 13a)");
    expect(defaultVersionLabel(B, buildPlan(B, incoming(["138"])))).toBe("Page 138");
    expect(defaultVersionLabel(B, { rows: [], removed: [at("14")] })).toBe("Removed 14");
    const many = buildPlan(B, incoming(["141", "142", "143", "144", "145", "146", "147"]));
    expect(defaultVersionLabel(B, many)).toBe("Pages 141, 142, 143, 144, 145 +2 more");
  });
});
