// "Add pages" (replacement pages for a PDF script): what to do with each incoming page,
// proposed from its printed label and editable before anything is created, and the page
// order of the merged PDF. Pure; the panel (AddPagesPanel.tsx) reads the files and builds
// the PDF.
//
// Proposals: a label the current version has → replace that page; a combined label
// ("45-46") → replace 45 and 46 (or the base's own "45-46"); a page whose number a combined
// base page covers ("68" vs "68-69") → replace that page; any other label → insert after
// the base page with the greatest label below it (natural order: 139 < 139a < 139b < 140);
// no label, or nothing below it → the user chooses. Base pages are physical PDF pages
// (0-based `index`), so two pages with one label stay apart.
import { compareLabels, labelNumbers, labelRange, sameLabel } from "../extract/labels";

/** A page of the current version's PDF. `label` null: no text on it (kept where it is). */
export interface BasePage {
  index: number;
  label: string | null;
}

export interface IncomingPage {
  /** Stable key (file and page). */
  key: string;
  /** Which incoming file (0-based, in the order they were added) and which of its pages. */
  file: number;
  index: number;
  fileName: string;
  label: string | null;
  /** The page's first line of text, to tell pages apart. */
  firstLine: string;
  /** A small rendering (data URL), when the browser could draw one. */
  thumb?: string;
}

export type RowAction =
  | { kind: "replace"; targets: number[] }
  /** After base page `after`; -1 = before the first page. */
  | { kind: "insert"; after: number }
  | { kind: "skip" }
  /** Not proposed: the user has to choose. */
  | { kind: "choose" };

export interface PlanRow {
  page: IncomingPage;
  action: RowAction;
  /** Why the proposal is what it is, when that isn't obvious ("No page label found"). */
  why?: string;
}

/** The incoming pages' rows and the base pages removed with no replacement. */
export interface Plan {
  rows: PlanRow[];
  removed: number[];
}

/** One page of the merged PDF. */
export type PageRef = { src: "base"; index: number } | { src: "in"; file: number; index: number };

/** Base pages' labels, for display: "34", or "PDF page 7" for a page without one. */
export function basePageName(p: BasePage): string {
  return p.label ?? `PDF page ${p.index + 1}`;
}

/** The base pages with these indexes, in order. */
function namesOf(base: readonly BasePage[], indexes: readonly number[]): string {
  return indexes
    .map((i) => base.find((p) => p.index === i))
    .filter((p): p is BasePage => !!p)
    .map(basePageName)
    .join(", ");
}

/** "Replace 138", "Insert after 139", "Insert before 1", "Skip", "Choose…". */
export function actionText(base: readonly BasePage[], a: RowAction): string {
  switch (a.kind) {
    case "replace":
      return `Replace ${namesOf(base, a.targets)}`;
    case "insert":
      return a.after < 0
        ? `Insert before ${base[0] ? basePageName(base[0]) : "the first page"}`
        : `Insert after ${namesOf(base, [a.after])}`;
    case "skip":
      return "Skip";
    case "choose":
      return "Choose…";
  }
}

/** What to propose for one incoming label among the base pages. */
export function proposeAction(
  base: readonly BasePage[],
  label: string | null,
): { action: RowAction; why?: string } {
  if (label === null) return { action: { kind: "choose" }, why: "No page label found." };
  const labelled = base.filter((p): p is BasePage & { label: string } => p.label !== null);
  const exact = labelled.filter((p) => sameLabel(p.label, label));
  if (exact.length > 0) {
    return {
      action: { kind: "replace", targets: [(exact[0] as BasePage).index] },
      why:
        exact.length > 1
          ? `${exact.length} pages are labelled ${label}: replacing the first.`
          : undefined,
    };
  }
  // Page numbers it covers vs the base's: "45-46" → 45 and 46; "68" → a base "68-69".
  const nums = labelNumbers(label);
  if (nums.length > 0) {
    const overlap = labelled.filter((p) => labelNumbers(p.label).some((n) => nums.includes(n)));
    if (overlap.length > 0) {
      return {
        action: { kind: "replace", targets: overlap.map((p) => p.index) },
        why: labelRange(label)
          ? undefined
          : `${label} is part of ${overlap.map((p) => p.label).join(", ")}.`,
      };
    }
  }
  // Insert after the greatest label below it (the later page on a tie).
  let after: (typeof labelled)[number] | null = null;
  for (const p of labelled) {
    if (compareLabels(p.label, label) < 0 && (!after || compareLabels(p.label, after.label) >= 0))
      after = p;
  }
  if (!after) {
    return {
      action: { kind: "choose" },
      why: `No page comes before ${label}: choose where it goes.`,
    };
  }
  return { action: { kind: "insert", after: after.index } };
}

/** The proposed plan for these incoming pages (nothing removed). */
export function buildPlan(base: readonly BasePage[], incoming: readonly IncomingPage[]): Plan {
  return {
    rows: incoming.map((page) => ({ page, ...proposeAction(base, page.label) })),
    removed: [],
  };
}

export interface PlanCheck {
  /** Per row key: what blocks Apply ("Two incoming pages are labelled 138"). */
  rowErrors: Map<string, string>;
  /** Per row key: worth a look, but allowed. */
  rowWarnings: Map<string, string>;
  /** Plan-wide blockers ("Nothing to change"). */
  errors: string[];
  /** Apply is allowed. */
  ok: boolean;
}

/**
 * What stops the plan from being applied: rows still to choose, two incoming pages with the
 * same label (both kept), a page both replaced and removed, nothing to do. Warnings: a
 * combined base page replaced by only part of its range ("68" for "68-69").
 */
export function checkPlan(base: readonly BasePage[], plan: Plan): PlanCheck {
  const rowErrors = new Map<string, string>();
  const rowWarnings = new Map<string, string>();
  const errors: string[] = [];
  const active = plan.rows.filter((r) => r.action.kind !== "skip");
  for (const r of active) {
    if (r.action.kind === "choose") rowErrors.set(r.page.key, "Choose what to do with this page.");
  }
  // Same label twice.
  for (const r of active) {
    const label = r.page.label;
    if (label === null || rowErrors.has(r.page.key)) continue;
    const twins = active.filter((o) => o !== r && o.page.label && sameLabel(o.page.label, label));
    if (twins.length > 0) {
      rowErrors.set(
        r.page.key,
        `${twins.length + 1} incoming pages are labelled ${label}: skip all but one.`,
      );
    }
  }
  const removed = new Set(plan.removed);
  // Replaced and removed; a combined page only partly replaced.
  const replacedBy = new Map<number, PlanRow[]>();
  for (const r of active) {
    if (r.action.kind !== "replace") continue;
    for (const t of r.action.targets) replacedBy.set(t, [...(replacedBy.get(t) ?? []), r]);
    const clash = r.action.targets.filter((t) => removed.has(t));
    if (clash.length && !rowErrors.has(r.page.key)) {
      rowErrors.set(
        r.page.key,
        `${namesOf(base, clash)} is also in “Remove pages”: replace it or remove it.`,
      );
    }
  }
  for (const [index, rows] of replacedBy) {
    const page = base.find((p) => p.index === index);
    const range = page?.label ? labelRange(page.label) : null;
    if (!page || !range) continue;
    const covered = new Set(rows.flatMap((r) => (r.page.label ? labelNumbers(r.page.label) : [])));
    const lost = range.filter((n) => !covered.has(n));
    if (lost.length === 0 || covered.size === 0) continue;
    for (const r of rows) {
      if (!rowErrors.has(r.page.key)) {
        rowWarnings.set(
          r.page.key,
          `Replaces all of ${page.label}: page ${lost.join(", ")} isn't in the new pages, so its text goes.`,
        );
      }
    }
  }
  if (active.length === 0 && plan.removed.length === 0) errors.push("Nothing to change yet.");
  return { rowErrors, rowWarnings, errors, ok: rowErrors.size === 0 && errors.length === 0 };
}

/** Rows in the order they land: by label (natural), then as they came. */
function byLabel(rows: readonly PlanRow[]): PlanRow[] {
  return rows
    .map((r, k) => ({ r, k }))
    .sort((x, y) => {
      const a = x.r.page.label;
      const b = y.r.page.label;
      const c = a !== null && b !== null ? compareLabels(a, b) : 0;
      return c || x.k - y.k;
    })
    .map((x) => x.r);
}

/**
 * The merged PDF's pages: the base's `baseCount` pages in order, each replaced page swapped
 * for its replacements (at the first page they replace; the others drop out), inserts after
 * their page (or first, for -1), removed pages dropped; rows sharing a place go in label
 * order. Rows still to choose, and skipped ones, are left out.
 */
export function mergeOrder(baseCount: number, plan: Plan): PageRef[] {
  const removed = new Set(plan.removed);
  const replaced = new Set<number>();
  const replaceAt = new Map<number, PlanRow[]>();
  const insertAfter = new Map<number, PlanRow[]>();
  for (const r of plan.rows) {
    const a = r.action;
    if (a.kind === "replace" && a.targets.length > 0) {
      for (const t of a.targets) replaced.add(t);
      const at = Math.min(...a.targets);
      replaceAt.set(at, [...(replaceAt.get(at) ?? []), r]);
    } else if (a.kind === "insert") {
      const at = Math.max(-1, Math.min(a.after, baseCount - 1));
      insertAfter.set(at, [...(insertAfter.get(at) ?? []), r]);
    }
  }
  const ref = (r: PlanRow): PageRef => ({ src: "in", file: r.page.file, index: r.page.index });
  const out: PageRef[] = byLabel(insertAfter.get(-1) ?? []).map(ref);
  for (let i = 0; i < baseCount; i++) {
    out.push(...byLabel(replaceAt.get(i) ?? []).map(ref));
    if (!replaced.has(i) && !removed.has(i)) out.push({ src: "base", index: i });
    out.push(...byLabel(insertAfter.get(i) ?? []).map(ref));
  }
  return out;
}

/** The version label to suggest: "Pages 138, 139a, 140", "… (removed 45)". */
export function defaultVersionLabel(base: readonly BasePage[], plan: Plan): string {
  const kept = plan.rows.filter((r) => r.action.kind !== "skip" && r.action.kind !== "choose");
  const labels = byLabel(kept).map((r) => r.page.label ?? "?");
  const MAX = 6;
  const list =
    labels.length > MAX
      ? `${labels.slice(0, MAX - 1).join(", ")} +${labels.length - MAX + 1} more`
      : labels.join(", ");
  const gone = namesOf(
    base,
    [...plan.removed].sort((a, b) => a - b),
  );
  const head = labels.length ? `${labels.length === 1 ? "Page" : "Pages"} ${list}` : "";
  if (!gone) return head;
  return head ? `${head} (removed ${gone})` : `Removed ${gone}`;
}
