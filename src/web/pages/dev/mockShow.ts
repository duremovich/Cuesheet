// In-memory show for the /dev/grid page, seeded at build time from the Some Like It Hot
// Airtable export in examples/. Dev/preview builds only (see ./routes.tsx). Implements the
// DataGrid callbacks for real: fractional-index ordering, scene links, content creation.

import { generateKeyBetween } from "fractional-indexing";
import Papa from "papaparse";
import breakdownCsv from "../../../../examples/Breakdown-Grid view.csv?raw";
import contentCsv from "../../../../examples/Content-Grid view.csv?raw";
import cueCsv from "../../../../examples/Cue List-Video Cue List View.csv?raw";
import personnelCsv from "../../../../examples/Personnel-Grid view.csv?raw";
import type { InsertPosition, PickerItem } from "../../components/grid";

export interface MockScene {
  id: string;
  number: string;
  name: string;
  song: string;
}

export interface MockContent {
  id: string;
  name: string;
  sceneId: string | null;
}

export interface MockPerson {
  id: string;
  name: string;
  role: string;
}

export interface MockCue {
  id: string;
  order: string;
  sceneId: string | null;
  isSection: boolean;
  number: string;
  page: string;
  smCall: string;
  lx: string;
  timecode: string;
  msr: number | null;
  description: string;
  status: string | null;
  assignees: PickerItem[];
  content: PickerItem[];
  notes: string;
  programmed: boolean;
}

export const STATUS_OPTIONS = [
  { value: "NOT STARTED", label: "Not started", color: "gray" },
  { value: "IN PROCESS", label: "In process", color: "yellow" },
  { value: "RENDERED", label: "Rendered", color: "blue" },
  { value: "CUED", label: "Cued", color: "green" },
  { value: "CUT", label: "Cut", color: "red" },
];

export function parseCsv(text: string): Record<string, string>[] {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: false,
  });
  return res.data.filter((r) => Object.keys(r).length > 1);
}

const splitList = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** A scene number from a content item: its Scene field ("S100 - …"), else its SSS- prefix. */
export function contentSceneNumber(sceneField: string, name: string): string | null {
  const m = /^S?(\d{3})\b/.exec(sceneField.trim()) ?? /^(\d{3})-/.exec(name.trim());
  return m?.[1] ?? null;
}

export interface Seed {
  scenes: MockScene[];
  content: MockContent[];
  people: MockPerson[];
  cues: MockCue[];
}

/** Parses the example CSVs into scenes, content, people and cues (in show order). */
export function seedFromExamples(): Seed {
  const scenes: MockScene[] = parseCsv(breakdownCsv)
    .map((r) => {
      const full = (r["Scene Name"] ?? "").trim();
      const m = /^(\d+)\s+(.*)$/.exec(full);
      return {
        id: `s${m?.[1] ?? full}`,
        number: m?.[1] ?? "",
        name: m?.[2] ?? full,
        song: (r["Song Name"] ?? "").trim(),
      };
    })
    .filter((s) => s.number);
  const sceneByNumber = new Map(scenes.map((s) => [s.number, s]));

  const content: MockContent[] = parseCsv(contentCsv)
    .filter((r) => (r.Name ?? "").trim())
    .map((r, i) => {
      const name = (r.Name ?? "").trim();
      const num = contentSceneNumber(r.Scene ?? "", name);
      return { id: `ct${i + 1}`, name, sceneId: (num && sceneByNumber.get(num)?.id) || null };
    });
  const contentByName = new Map(content.map((c) => [c.name, c]));

  const people: MockPerson[] = parseCsv(personnelCsv)
    .filter((r) => (r.Name ?? "").trim())
    .map((r, i) => ({ id: `p${i + 1}`, name: (r.Name ?? "").trim(), role: (r.Role ?? "").trim() }));
  const personByName = new Map(people.map((p) => [p.name, p]));

  const cues: MockCue[] = [];
  let order: string | null = null;
  parseCsv(cueCsv).forEach((r, i) => {
    order = generateKeyBetween(order, null);
    const contentItems = splitList(r.Content).map((name) => {
      let c = contentByName.get(name);
      if (!c) {
        c = { id: `ct${content.length + 1}`, name, sceneId: null };
        content.push(c);
        contentByName.set(name, c);
      }
      return { id: c.id, label: c.name };
    });
    const assignees = splitList(r.Assignee).map((name) => {
      let p = personByName.get(name);
      if (!p) {
        p = { id: `p${people.length + 1}`, name, role: "" };
        people.push(p);
        personByName.set(name, p);
      }
      return { id: p.id, label: p.name };
    });
    const firstContent = contentItems[0] ? contentByName.get(contentItems[0].label) : undefined;
    const status = (r.STATUS ?? "").trim();
    const msr = Number.parseFloat(r.MSR ?? "");
    cues.push({
      id: `c${i + 1}`,
      order,
      sceneId: firstContent?.sceneId ?? null,
      isSection: false,
      number: (r["Cue Number"] ?? "").trim(),
      page: (r.PG ?? "").trim(),
      smCall: (r["SM Call"] ?? "").trim(),
      lx: (r.LX ?? "").trim(),
      timecode: (r.Timecode ?? "").trim(),
      msr: Number.isFinite(msr) ? msr : null,
      description: (r.Description ?? "").trim(),
      status: status || null,
      assignees,
      content: contentItems,
      notes: (r["Content Notes"] ?? "").trim(),
      programmed: status === "CUED",
    });
  });

  // A section row (the export has none): the intermission divider after cue 40.50.
  const at = cues.findIndex((c) => c.number === "40.50");
  if (at >= 0) {
    const prev = cues[at] as MockCue;
    const next = cues[at + 1];
    cues.splice(at + 1, 0, {
      ...blankCue("sec1", generateKeyBetween(prev.order, next?.order ?? null)),
      sceneId: prev.sceneId,
      isSection: true,
      description: "INTERMISSION",
    });
  }
  return { scenes, content, people, cues };
}

function blankCue(id: string, order: string): MockCue {
  return {
    id,
    order,
    sceneId: null,
    isSection: false,
    number: "",
    page: "",
    smCall: "",
    lx: "",
    timecode: "",
    msr: null,
    description: "",
    status: null,
    assignees: [],
    content: [],
    notes: "",
    programmed: false,
  };
}

/** Copies the seed's cues `total` times over (for the 5,000-row stress test). */
export function stressSeed(seed: Seed, total: number): Seed {
  const base = seed.cues.filter((c) => !c.isSection);
  const cues: MockCue[] = [];
  let order: string | null = null;
  for (let i = 0; i < total; i++) {
    const b = base[i % base.length] as MockCue;
    order = generateKeyBetween(order, null);
    cues.push({
      ...b,
      id: `x${i + 1}`,
      order,
      number: String(i + 1),
      description: `Stress row ${i + 1}`,
    });
  }
  return { ...seed, cues };
}

const UNASSIGNED = "unassigned";

/** A tiny observable store with the grid's operations. */
export class MockShowStore {
  scenes: MockScene[];
  content: MockContent[];
  people: MockPerson[];
  private cues = new Map<string, MockCue>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  version = 0;

  constructor(seed: Seed) {
    this.scenes = seed.scenes;
    this.content = [...seed.content];
    this.people = seed.people;
    for (const c of seed.cues) this.cues.set(c.id, c);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** All cues in show order. */
  list(): MockCue[] {
    return [...this.cues.values()].sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
    );
  }

  get(id: string): MockCue | undefined {
    return this.cues.get(id);
  }

  sceneTitle(sceneId: string | null): string {
    const s = this.scenes.find((x) => x.id === sceneId);
    return s ? `${s.number} ${s.name}` : "Unassigned";
  }

  /** Groups for the grid: Unassigned first, then scenes in number order. */
  groups(): { id: string; title: string; subtitle?: string; rows: MockCue[] }[] {
    const all = this.list();
    const known = new Set(this.scenes.map((s) => s.id));
    const out = [
      {
        id: UNASSIGNED,
        title: "Unassigned",
        subtitle: "Cues with no scene",
        rows: all.filter((c) => !c.sceneId || !known.has(c.sceneId)),
      },
    ];
    for (const s of this.scenes) {
      out.push({
        id: s.id,
        title: `${s.number} ${s.name}`,
        subtitle: s.song,
        rows: all.filter((c) => c.sceneId === s.id),
      });
    }
    return out;
  }

  edit(id: string, key: string, value: unknown) {
    const c = this.cues.get(id);
    if (!c) return;
    this.cues.set(id, { ...c, [key]: value } as MockCue);
    this.changed();
  }

  /** The order key for a position (neighbors are in global show order). */
  private keyFor(pos: InsertPosition, exclude?: string): string {
    const all = this.list().filter((c) => c.id !== exclude);
    const i =
      pos.afterRowId !== undefined
        ? all.findIndex((c) => c.id === pos.afterRowId) + 1
        : pos.beforeRowId !== undefined
          ? all.findIndex((c) => c.id === pos.beforeRowId)
          : -1;
    if (i >= 0 && (pos.afterRowId !== undefined ? i > 0 : true)) {
      return generateKeyBetween(all[i - 1]?.order ?? null, all[i]?.order ?? null);
    }
    // End of a group: after its last cue, else at the end of the show.
    const inGroup = all.filter((c) => this.groupOf(c) === pos.groupId);
    const last = inGroup.at(-1);
    if (last) {
      const j = all.indexOf(last);
      return generateKeyBetween(last.order, all[j + 1]?.order ?? null);
    }
    return generateKeyBetween(all.at(-1)?.order ?? null, null);
  }

  private groupOf(c: MockCue): string {
    return c.sceneId && this.scenes.some((s) => s.id === c.sceneId) ? c.sceneId : UNASSIGNED;
  }

  private sceneFor(pos: InsertPosition): string | null | undefined {
    if (pos.groupId === undefined) return undefined;
    return pos.groupId === UNASSIGNED ? null : pos.groupId;
  }

  insert = (pos: InsertPosition): string => {
    const id = `n${this.nextId++}`;
    const neighbor = this.cues.get(pos.afterRowId ?? pos.beforeRowId ?? "");
    const scene = this.sceneFor(pos);
    this.cues.set(id, {
      ...blankCue(id, this.keyFor(pos)),
      sceneId: scene === undefined ? (neighbor?.sceneId ?? null) : scene,
    });
    this.changed();
    return id;
  };

  move = (id: string, pos: InsertPosition) => {
    const c = this.cues.get(id);
    if (!c) return;
    const scene = this.sceneFor(pos);
    this.cues.set(id, {
      ...c,
      order: this.keyFor(pos, id),
      sceneId: scene === undefined ? c.sceneId : scene,
    });
    this.changed();
  };

  remove = (ids: string[]) => {
    for (const id of ids) this.cues.delete(id);
    this.changed();
  };

  /** Content matching `q`, same-scene items first (R5a). */
  searchContent = (q: string, sceneId?: string | null): PickerItem[] => {
    const t = q.trim().toLowerCase();
    const matches = this.content.filter((c) => !t || c.name.toLowerCase().includes(t));
    const same = sceneId ? matches.filter((c) => c.sceneId === sceneId) : [];
    return [...same, ...matches.filter((c) => !same.includes(c))]
      .slice(0, 50)
      .map((c) => ({ id: c.id, label: c.name, secondary: this.sceneTitle(c.sceneId) }));
  };

  /** New content in the given scene (the row's scene when created from a cue). */
  createContent = async (name: string, sceneId: string | null = null): Promise<PickerItem> => {
    const c: MockContent = { id: `ct${this.content.length + 1}`, name, sceneId };
    this.content.push(c);
    this.changed();
    return { id: c.id, label: c.name };
  };

  searchPeople = (q: string): PickerItem[] => {
    const t = q.trim().toLowerCase();
    return this.people
      .filter((p) => !t || p.name.toLowerCase().includes(t))
      .slice(0, 50)
      .map((p) => ({ id: p.id, label: p.name, ...(p.role ? { secondary: p.role } : {}) }));
  };
}

/**
 * The ghost cue number for a row inserted between two cues (ux.md §Inserting a cue):
 * 14.2 | 14.4 → 14.3; 14.2 | 14.25 → 14.22; after the last cue → the next whole number.
 */
export function suggestCueNumber(
  prev: string | undefined,
  next: string | undefined,
): string | undefined {
  const a = prev === undefined ? Number.NaN : Number.parseFloat(prev);
  const b = next === undefined ? Number.NaN : Number.parseFloat(next);
  if (Number.isNaN(a)) return Number.isNaN(b) ? "1" : undefined;
  if (Number.isNaN(b)) return String(Math.floor(a) + 1);
  if (b <= a) return undefined;
  const decimals = (x: string | undefined) => (x?.split(".")[1] ?? "").length;
  for (let d = Math.max(decimals(prev), decimals(next)); d <= 4; d++) {
    const f = 10 ** d;
    const mid = Math.floor(((a + b) / 2) * f + 1e-9) / f;
    if (mid > a && mid < b) return mid.toFixed(d);
  }
  return undefined;
}

/** Duplicate-number warnings and ghost numbers for unnumbered cues, by row id. */
export function cueNumberHints(cues: MockCue[]): Map<string, { warning?: string; ghost?: string }> {
  const list = cues.filter((c) => !c.isSection);
  const counts = new Map<string, number>();
  for (const c of list) if (c.number) counts.set(c.number, (counts.get(c.number) ?? 0) + 1);
  const out = new Map<string, { warning?: string; ghost?: string }>();
  list.forEach((c, i) => {
    if (c.number && (counts.get(c.number) ?? 0) > 1) {
      out.set(c.id, { warning: `Duplicate cue number ${c.number}` });
    } else if (!c.number) {
      const prev = list.slice(0, i).findLast((x) => x.number)?.number;
      const next = list.slice(i + 1).find((x) => x.number)?.number;
      const ghost = suggestCueNumber(prev, next);
      if (ghost) out.set(c.id, { ghost });
    }
  });
  return out;
}
