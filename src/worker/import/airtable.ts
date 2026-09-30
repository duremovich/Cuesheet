// Airtable CSV import (R25): turns the five core CSV exports into a list of ops that the
// ShowDO applies like any other batch (so history and broadcast work). Mapping follows
// docs/spec/data-model.md §"Mapping from the Airtable base". Pure: no I/O.
import Papa from "papaparse";
import { newId } from "../../shared/ids";
import type { FieldValues, ImportResponse, Op } from "../../shared/ops";
import type { FieldOptions, TableName } from "../../shared/tables";
import { parseLength, type Unit } from "../../shared/units";

export type ImportKind = "scenes" | "persons" | "content" | "cues" | "notes" | "surfaces";

export interface CsvFile {
  name: string;
  text: string;
}

type CsvRow = Record<string, string>;

const FILENAME_PREFIXES: [string, ImportKind][] = [
  ["breakdown", "scenes"],
  ["personnel", "persons"],
  ["content", "content"],
  ["cue list", "cues"],
  ["notes", "notes"],
  ["surfaces", "surfaces"],
];

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const res = Papa.parse<CsvRow>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: false,
  });
  const headers = res.meta.fields ?? [];
  // A trailing newline yields one [""] row; drop rows that have no cells at all.
  const rows = res.data.filter((r) => Object.keys(r).length > 1 || Object.values(r).some(Boolean));
  return { headers, rows };
}

/** Which table a CSV holds, from its file name (Airtable's `<Table>-<View>.csv`) or headers. */
export function detectKind(fileName: string, headers: string[]): ImportKind | null {
  const base = (fileName.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  for (const [prefix, kind] of FILENAME_PREFIXES) {
    if (base.startsWith(`${prefix}-`) || base === `${prefix}.csv`) return kind;
  }
  const h = new Set(headers);
  if (h.has("Cue Number")) return "cues";
  if (h.has("Note") && h.has("Cue #")) return "notes";
  if (h.has("Scene Name") && h.has("Location")) return "scenes";
  if (h.has("Name") && (h.has("Creator") || h.has("LOOP IN"))) return "content";
  if (h.has("Name") && h.has("Role")) return "persons";
  if (h.has("Name") && h.has("Channel Name")) return "surfaces";
  return null;
}

/** Split a multi-value link cell. Airtable quotes values that contain commas, CSV-style. */
export function splitMulti(cell: string | undefined): string[] {
  const t = clean(cell);
  if (!t) return [];
  const parsed = Papa.parse<string[]>(t, { header: false });
  const values = (parsed.data[0] ?? []).map((v) => v.trim()).filter(Boolean);
  return [...new Set(values)];
}

function clean(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** "9/23/2026 1:47pm" → epoch ms. Airtable exports local time without a zone; read as UTC. */
export function parseAirtableTime(v: string | undefined): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(v?.trim() ?? "");
  if (!m) return null;
  const [, mo, d, y, h, mi, ap] = m;
  let hour = Number(h) % 12;
  if (ap?.toLowerCase() === "pm") hour += 12;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi));
}

/** The unit a "Width (Meters)" style header names (meters when it names none). */
export function headerUnit(header: string): Unit {
  return headerUnitOrNull(header) ?? "m";
}

/** The header's unit; null when its parentheses name something that isn't a unit. */
export function headerUnitOrNull(header: string): Unit | null {
  const u = /\(([^)]*)\)/.exec(header)?.[1]?.trim().toLowerCase() ?? "";
  if (u === "" || /^(met(er|re)s?|m)$/.test(u)) return "m";
  if (/^(feet|foot|ft)$/.test(u)) return "ft";
  if (/^(inches|inch|in)$/.test(u)) return "in";
  if (/^(centimet(er|re)s?|cm)$/.test(u)) return "cm";
  if (/^(millimet(er|re)s?|mm)$/.test(u)) return "mm";
  return null;
}

/** "CH02.1" → "CH02" (a region's parent channel); null for a top-level channel. */
export function parentChannel(channel: string): string | null {
  const i = channel.lastIndexOf(".");
  return i > 0 ? channel.slice(0, i) : null;
}

/** "101 Scene One: Hottest Speakeasy" → { number: "101", name: "Scene One: …" }. */
export function splitSceneName(v: string): { number: string | null; name: string } {
  const m = /^(\S*\d\S*)\s+(.+)$/s.exec(v.trim());
  return m?.[1] && m[2] ? { number: m[1], name: m[2].trim() } : { number: null, name: v.trim() };
}

class Warnings {
  private readonly counts = new Map<string, number>();
  add(msg: string) {
    this.counts.set(msg, (this.counts.get(msg) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([m, n]) => (n > 1 ? `${m} (×${n})` : m));
  }
}

/** Match a CSV value to a select option case-insensitively ("IN PROCESS" → "In process"). */
function optionMatcher(options: FieldOptions, warnings: Warnings) {
  return (table: TableName, field: string, raw: string | null): string | null => {
    if (!raw) return null;
    const opts = options[`${table}.${field}`] ?? [];
    const hit = opts.find((o) => o.value.toLowerCase() === raw.toLowerCase());
    if (!hit) warnings.add(`${table}.${field}: "${raw}" is not an option; left empty`);
    return hit?.value ?? null;
  };
}

export interface ImportPlan extends ImportResponse {
  ops: Op[];
}

/**
 * Build the ops for an import. Rows keep CSV order as show order (appended after anything
 * already in the show). Links resolve by primary text among the imported rows.
 */
export function buildAirtableImport(files: CsvFile[], fieldOptions: FieldOptions): ImportPlan {
  const warnings = new Warnings();
  const option = optionMatcher(fieldOptions, warnings);
  let surfaceHeaders: string[] = [];
  const byKind = new Map<ImportKind, CsvRow[]>();
  for (const f of files) {
    const { headers, rows } = parseCsv(f.text);
    const kind = detectKind(f.name, headers);
    if (!kind) {
      warnings.add(
        `${f.name}: not one of Breakdown, Personnel, Content, Cue List, Notes, Surfaces; skipped`,
      );
      continue;
    }
    if (byKind.has(kind)) warnings.add(`${f.name}: a second ${kind} file; skipped`);
    else {
      byKind.set(kind, rows);
      if (kind === "surfaces") surfaceHeaders = headers;
    }
  }

  const ops: Op[] = [];
  const created = { scenes: 0, cues: 0, content: 0, notes: 0, persons: 0, surfaces: 0 };

  // ---- surfaces (first: scenes link to them) ----
  // Name, Channel Name, Width/Height (<unit>); a region's parent comes from its channel
  // ("CH02.1" is a region of "CH02").
  const surfaceByText = new Map<string, string>();
  const surfaceByChannel = new Map<string, string>();
  const surfaceChannel: { id: string; channel: string | null; index: number }[] = [];
  const widthHeader = surfaceHeaders.find((h) => /^width\b/i.test(h.trim()));
  const heightHeader = surfaceHeaders.find((h) => /^height\b/i.test(h.trim()));
  for (const h of [widthHeader, heightHeader]) {
    if (h && (byKind.get("surfaces")?.length ?? 0) > 0 && headerUnitOrNull(h) === null) {
      warnings.add(`Surfaces: "${h}" names no unit Cuesheet knows; read as meters`);
    }
  }
  const length = (row: CsvRow, header: string | undefined, name: string | null) => {
    const raw = header ? clean(row[header]) : null;
    if (!raw || !header) return null;
    const r = parseLength(raw, headerUnit(header));
    if (r && "m" in r) return r.m;
    warnings.add(
      `Surfaces: "${raw}" in ${header} of ${name ?? "a surface"} is not a length; left empty`,
    );
    return null;
  };
  let surfaceIndex = 0;
  for (const r of byKind.get("surfaces") ?? []) {
    if (!Object.values(r).some((v) => v.trim())) continue;
    const name = clean(r.Name);
    const channel = clean(r["Channel Name"]);
    const id = newId();
    if (name && !surfaceByText.has(name.toLowerCase())) surfaceByText.set(name.toLowerCase(), id);
    if (channel && !surfaceByChannel.has(channel.toLowerCase())) {
      surfaceByChannel.set(channel.toLowerCase(), id);
    }
    surfaceChannel.push({ id, channel, index: surfaceIndex++ });
    ops.push({
      op: "create",
      table: "surfaces",
      id,
      fields: {
        name,
        channel,
        width: length(r, widthHeader, name),
        height: length(r, heightHeader, name),
      },
    });
    created.surfaces++;
  }
  // Parents: set in the create when the parent comes first in the CSV, else afterwards.
  const createIndex = new Map(
    ops.flatMap((o, i) => (o.op === "create" && o.table === "surfaces" ? [[o.id, i]] : [])),
  );
  for (const s of surfaceChannel) {
    const pc = s.channel ? parentChannel(s.channel) : null;
    const parentId = pc ? surfaceByChannel.get(pc.toLowerCase()) : undefined;
    if (pc && !parentId) {
      warnings.add(
        `Surfaces: ${s.channel} looks like a region of ${pc}, which isn't in the file; left top-level`,
      );
    }
    if (!parentId || parentId === s.id) continue;
    const at = createIndex.get(s.id) as number;
    const op = ops[at];
    if ((createIndex.get(parentId) as number) < at && op?.op === "create") {
      op.fields.parent_id = parentId;
    } else {
      ops.push({ op: "update", table: "surfaces", id: s.id, fields: { parent_id: parentId } });
    }
  }
  /** By name, else by channel ("L PRO TOP" or "CH02.1"). */
  const surface = (text: string): string | null =>
    surfaceByText.get(text.toLowerCase()) ?? surfaceByChannel.get(text.toLowerCase()) ?? null;

  // ---- persons ----
  const personByName = new Map<string, string>();
  let skippedPhotos = 0;
  for (const r of byKind.get("persons") ?? []) {
    const name = clean(r.Name);
    if (!name && !Object.values(r).some((v) => v.trim())) continue;
    const id = newId();
    if (name && !personByName.has(name.toLowerCase())) personByName.set(name.toLowerCase(), id);
    if (clean(r.Photo)) skippedPhotos++;
    ops.push({
      op: "create",
      table: "persons",
      id,
      fields: {
        name,
        role: clean(r.Role),
        email: clean(r.Email),
        organization: clean(r.Theatre),
        group: clean(r.Cast) ? option("persons", "group", "Cast") : null,
      },
    });
    created.persons++;
  }
  if (skippedPhotos)
    warnings.add(`Personnel: ${skippedPhotos} photos not imported (attachments come later)`);
  /** Resolve a person by name; names not in Personnel get a new person (name only). */
  const person = (name: string): string => {
    const existing = personByName.get(name.toLowerCase());
    if (existing) return existing;
    const id = newId();
    personByName.set(name.toLowerCase(), id);
    ops.push({ op: "create", table: "persons", id, fields: { name } });
    created.persons++;
    warnings.add(`Created person '${name}' (not in Personnel)`);
    return id;
  };

  // ---- scenes ----
  const sceneByText = new Map<string, string>();
  const sceneByNumber = new Map<string, string>();
  for (const r of byKind.get("scenes") ?? []) {
    const full = clean(r["Scene Name"]);
    if (!full && !Object.values(r).some((v) => v.trim())) continue;
    const { number, name } = splitSceneName(full ?? "");
    const id = newId();
    if (full) sceneByText.set(full.toLowerCase(), id);
    if (number && !sceneByNumber.has(number)) sceneByNumber.set(number, id);
    ops.push({
      op: "create",
      table: "scenes",
      id,
      fields: {
        number,
        name: name || null,
        location: clean(r.Location),
        time_of_day: clean(r["Time of Day"]),
        song: clean(r["Song Name"]),
        stage_direction: clean(r["Top of Scene Stage Direction"]),
        description: clean(r["Scene Description"]),
        video_overview: clean(r["Video Overview"]),
      },
    });
    created.scenes++;
    for (const text of splitMulti(r.Surfaces)) {
      const targetId = surface(text);
      if (!targetId) warnings.add(`Breakdown: surface "${text}" not found; link skipped`);
      else ops.push({ op: "link", table: "scenes", id, field: "surfaces", targetId });
    }
  }
  /** By full "Scene Name" text, else by the first number in it ("S100 - OVERTURE" → 100). */
  const scene = (text: string): string | null =>
    sceneByText.get(text.toLowerCase()) ?? sceneByNumber.get(/\d+/.exec(text)?.[0] ?? "") ?? null;

  // ---- content ----
  const contentByName = new Map<string, string>();
  const contentScene = new Map<string, string | null>();
  let versions = 0;
  for (const r of byKind.get("content") ?? []) {
    if (!Object.values(r).some((v) => v.trim())) continue;
    const name = clean(r.Name);
    const id = newId();
    if (name && !contentByName.has(name.toLowerCase())) contentByName.set(name.toLowerCase(), id);
    // Scene column when it resolves, else the SSS prefix of the SSS-NNN-NAME convention.
    const sceneText = splitMulti(r.Scene)[0];
    let sceneId = sceneText ? scene(sceneText) : null;
    if (sceneText && !sceneId) warnings.add(`Content: scene "${sceneText}" not found`);
    if (!sceneId && name) sceneId = sceneByNumber.get(/^(\d+)-/.exec(name)?.[1] ?? "") ?? null;
    contentScene.set(id, sceneId);
    if (clean(r.Version)) versions++;
    const creator = clean(r.Creator);
    ops.push({
      op: "create",
      table: "content",
      id,
      fields: {
        name,
        scene_id: sceneId,
        creator_id: creator ? person(creator) : null,
        loop_in: clean(r["LOOP IN"]),
        loop_out: clean(r["LOOP OUT"]),
      },
    });
    created.content++;
  }
  if (versions)
    warnings.add(`Content: ${versions} Version values not imported (content versions come later)`);
  const contentId = (name: string, what: string): string | null => {
    const id = contentByName.get(name.toLowerCase());
    if (!id) warnings.add(`${what}: content "${name}" not found; link skipped`);
    return id ?? null;
  };

  // ---- cues ----
  const cueIdsByNumber = new Map<string, string[]>();
  const cueRows = byKind.get("cues") ?? [];
  const cueFields: FieldValues[] = [];
  const CUE_TEXT_COLUMNS = [
    "PG",
    "SM Call",
    "LX",
    "Timecode",
    "AE Time",
    "MSR",
    "Description",
    "STATUS",
    "Assignee",
    "Content",
  ];
  for (const r of cueRows) {
    const number = clean(r["Cue Number"]);
    const hasText = CUE_TEXT_COLUMNS.some((c) => clean(r[c]));
    if (!number && !hasText) continue; // blank spacer row
    const id = newId();
    if (number) {
      const list = cueIdsByNumber.get(number) ?? [];
      list.push(id);
      cueIdsByNumber.set(number, list);
    }
    const contentIds = splitMulti(r.Content)
      .map((n) => contentId(n, `Cue ${number ?? "(section)"}`))
      .filter((x): x is string => x !== null);
    // The export has no Scene column (hidden in that view): take the scene of the linked
    // content when all of it agrees.
    const scenes = new Set(contentIds.map((c) => contentScene.get(c)).filter(Boolean));
    const sceneId = scenes.size === 1 ? ([...scenes][0] as string) : null;
    const fields: FieldValues = {
      number,
      scene_id: sceneId,
      page: clean(r.PG),
      sm_call: clean(r["SM Call"]),
      lx_cue: clean(r.LX),
      timecode: clean(r.Timecode),
      ae_time: clean(r["AE Time"]),
      measure: clean(r.MSR),
      description: clean(r.Description),
      status: option("cues", "status", clean(r.STATUS)),
      is_section: !number,
    };
    cueFields.push(fields); // scene_id may still be filled in by the pass below
    ops.push({ op: "create", table: "cues", id, fields });
    created.cues++;
    contentIds.forEach((targetId) => {
      ops.push({ op: "link", table: "cues", id, field: "content", targetId });
    });
    for (const name of splitMulti(r.Assignee)) {
      const p = person(name);
      ops.push({ op: "link", table: "cues", id, field: "assignees", targetId: p });
    }
  }
  // Second pass: a cue still without a scene takes it when the nearest scene-bearing cues
  // before and after it (CSV order, content-derived scenes only) agree.
  const derived = cueFields.map((f) => f.scene_id as string | null);
  let inferred = 0;
  derived.forEach((sceneId, i) => {
    if (sceneId) return;
    const before = derived.slice(0, i).findLast((s) => s !== null);
    const after = derived.slice(i + 1).find((s) => s !== null);
    const fields = cueFields[i];
    if (before && before === after && fields) {
      fields.scene_id = before;
      inferred++;
    }
  });
  const noScene = cueFields.filter((f) => !f.scene_id).length;
  if (inferred) {
    warnings.add(
      `Cue List: ${inferred} cues without content took their scene from the cues around them`,
    );
  }
  if (noScene) {
    warnings.add(
      `Cue List: ${noScene} cues have no scene (the export has no Scene column; scene comes from linked content or neighbouring cues) and show as Unassigned`,
    );
  }
  for (const [number, ids] of cueIdsByNumber) {
    if (ids.length > 1) warnings.add(`Cue List: cue number ${number} is used ${ids.length} times`);
  }

  // ---- notes ----
  for (const r of byKind.get("notes") ?? []) {
    if (!Object.values(r).some((v) => v.trim())) continue;
    const id = newId();
    const sceneTexts = splitMulti(r["Scene Name"]);
    const sceneIds = [...new Set(sceneTexts.map((s) => scene(s)))];
    for (const s of sceneTexts) if (!scene(s)) warnings.add(`Notes: scene "${s}" not found`);
    const realScenes = sceneIds.filter((s): s is string => s !== null);
    if (realScenes.length > 1) warnings.add("Notes: note links several scenes; kept the first");
    const contents = splitMulti(r.Content)
      .map((n) => contentId(n, "Notes"))
      .filter((x): x is string => x !== null);
    if (contents.length > 1)
      warnings.add("Notes: note links several content items; kept the first");
    const types = splitMulti(r.TYPE)
      .map((t) => option("notes", "type", t))
      .filter((t): t is string => t !== null);
    const status = clean(r.Done) ? "Done" : clean(r["In Progress"]) ? "In progress" : "Open";
    const createdAt = parseAirtableTime(r["Created Time"]);
    const createdBy = clean(r["created by"]);
    ops.push({
      op: "create",
      table: "notes",
      id,
      fields: {
        body: clean(r.Note),
        scene_id: realScenes[0] ?? null,
        content_id: contents[0] ?? null,
        type: [...new Set(types)],
        status: option("notes", "status", status),
        priority: option("notes", "priority", clean(r.Priority)),
        ...(createdAt !== null ? { created_at: createdAt } : {}),
        ...(createdBy ? { custom: { created_by_name: createdBy } } : {}),
      },
    });
    created.notes++;
    for (const number of splitMulti(r["Cue #"])) {
      const ids = cueIdsByNumber.get(number);
      if (!ids?.[0]) {
        warnings.add(`Notes: cue ${number} not found; link skipped`);
        continue;
      }
      if (ids.length > 1) {
        warnings.add(`Notes: cue number ${number} matches ${ids.length} cues; linked the first`);
      }
      ops.push({ op: "link", table: "notes", id, field: "cues", targetId: ids[0] });
    }
    for (const name of splitMulti(r["Assigned To"])) {
      const p = person(name);
      ops.push({ op: "link", table: "notes", id, field: "assignees", targetId: p });
    }
  }

  return { ops, created, warnings: warnings.list() };
}
