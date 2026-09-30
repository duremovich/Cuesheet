// Notes print layouts (R21, S3): "Notes by person" and "Notes by cue" for a session.
// Pure: rows and groups from the show's data, so they're unit-tested (notes.test.ts).
import type { CueRow, NoteRow, PersonRow, SceneRow } from "../../../../shared/tables";
import type { ShowData } from "../../../lib/show-state";
import { isOpen } from "../../notes/compose";

export interface NotePrintRow {
  note: NoteRow;
  cues: CueRow[];
  assignees: PersonRow[];
  scene: SceneRow | null;
  /** The note's place in show order: its first cue's index (∞ without a cue). */
  cueIndex: number;
}

export interface NoteGroup {
  id: string;
  title: string;
  subtitle?: string;
  person?: PersonRow;
  cue?: CueRow;
  rows: NotePrintRow[];
}

/** The sessions notes were taken in (first seen in time order), for the session picker. */
export function noteSessions(data: ShowData): string[] {
  const notes = [...data.tables.notes.values()].sort((a, b) => a.created_at - b.created_at);
  return [...new Set(notes.flatMap((n) => (n.session ? [n.session] : [])))];
}

/** Every note (in `session`, when given) with its links resolved. */
export function noteRows(data: ShowData, session: string | null): NotePrintRow[] {
  const cueIndex = new Map(data.order.cues.map((id, i) => [id, i]));
  const out: NotePrintRow[] = [];
  for (const note of data.tables.notes.values()) {
    if (session !== null && note.session !== session) continue;
    const cues = (data.joins.noteCues.get(note.id) ?? [])
      .flatMap((id) => data.tables.cues.get(id) ?? [])
      .sort((a, b) => (cueIndex.get(a.id) ?? 0) - (cueIndex.get(b.id) ?? 0));
    const assignees = (data.joins.noteAssignees.get(note.id) ?? []).flatMap(
      (id) => data.tables.persons.get(id) ?? [],
    );
    const sceneId = note.scene_id ?? cues[0]?.scene_id ?? null;
    out.push({
      note,
      cues,
      assignees,
      scene: sceneId ? (data.tables.scenes.get(sceneId) ?? null) : null,
      cueIndex: cues[0] ? (cueIndex.get(cues[0].id) ?? Number.POSITIVE_INFINITY) : Infinity,
    });
  }
  return out;
}

/** Open first (In progress counts as open), then cue order, then oldest first. */
export function compareForPrint(a: NotePrintRow, b: NotePrintRow): number {
  const open = Number(isOpen(b.note)) - Number(isOpen(a.note));
  if (open) return open;
  if (a.cueIndex !== b.cueIndex) return a.cueIndex < b.cueIndex ? -1 : 1;
  return a.note.created_at - b.note.created_at || (a.note.id < b.note.id ? -1 : 1);
}

export const UNASSIGNED_GROUP = "__unassigned__";
export const NO_CUE_GROUP = "__no_cue__";

const byName = (a: PersonRow, b: PersonRow) =>
  (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });

/**
 * One group per assignee (by name), a note under each of its assignees; notes nobody owns
 * last as "Unassigned". `personId` keeps just that person's group.
 */
export function groupByPerson(rows: NotePrintRow[], personId?: string | null): NoteGroup[] {
  const people = new Map<string, PersonRow>();
  for (const r of rows) for (const p of r.assignees) people.set(p.id, p);
  const groups: NoteGroup[] = [...people.values()].sort(byName).map((person) => ({
    id: person.id,
    title: person.name || "Unnamed person",
    ...(person.role ? { subtitle: person.role } : {}),
    person,
    rows: rows.filter((r) => r.assignees.some((a) => a.id === person.id)).sort(compareForPrint),
  }));
  const nobody = rows.filter((r) => r.assignees.length === 0).sort(compareForPrint);
  if (nobody.length) groups.push({ id: UNASSIGNED_GROUP, title: "Unassigned", rows: nobody });
  return personId ? groups.filter((g) => g.id === personId) : groups;
}

/** "Q 14.20 · Kaleidoscope" */
export function cueHeading(cue: CueRow): string {
  const num = cue.number ? `Q ${cue.number}` : "Q (no number)";
  return cue.description ? `${num} · ${cue.description}` : num;
}

/**
 * One group per cue with notes, in show order (a note on two cues shows under both), then
 * the notes without a cue ("No cue").
 */
export function groupByCue(rows: NotePrintRow[], data: ShowData): NoteGroup[] {
  const byCue = new Map<string, NotePrintRow[]>();
  for (const r of rows) {
    for (const c of r.cues) {
      const list = byCue.get(c.id) ?? [];
      list.push(r);
      byCue.set(c.id, list);
    }
  }
  const groups: NoteGroup[] = [];
  for (const id of data.order.cues) {
    const list = byCue.get(id);
    const cue = data.tables.cues.get(id);
    if (!list || !cue) continue;
    const scene = cue.scene_id ? data.tables.scenes.get(cue.scene_id) : undefined;
    groups.push({
      id,
      title: cueHeading(cue),
      ...(scene ? { subtitle: [scene.number, scene.name].filter(Boolean).join(" ") } : {}),
      cue,
      rows: list.sort(compareForPrint),
    });
  }
  const none = rows.filter((r) => r.cues.length === 0).sort(compareForPrint);
  if (none.length) groups.push({ id: NO_CUE_GROUP, title: "No cue", rows: none });
  return groups;
}

/** "Content, Programming" */
export function typeText(note: NoteRow): string {
  return note.type.join(", ");
}

export function cueNumbers(r: NotePrintRow): string {
  return r.cues.map((c) => c.number ?? "?").join(", ");
}

/**
 * A plain-text summary of one person's notes (the "Distribute notes" email body), open
 * ones first; capped so the mailto: link stays within what mail apps accept.
 */
export function notesEmailBody(
  group: NoteGroup,
  opts: { show: string; session: string | null; link?: string | null; max?: number },
): string {
  const max = opts.max ?? 1500;
  const lines = [
    `${opts.show} notes${opts.session ? ` – ${opts.session}` : ""} for ${group.title}:`,
    "",
  ];
  let used = lines.join("\n").length;
  let omitted = 0;
  for (const r of group.rows) {
    const cue = r.cues.length ? `Q ${cueNumbers(r)}: ` : "";
    const status = isOpen(r.note) ? "" : " (done)";
    const line = `- ${cue}${(r.note.body ?? "(photo)").replace(/\s+/g, " ").trim()}${status}`;
    if (used + line.length + 1 > max) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted) lines.push(`…and ${omitted} more.`);
  if (opts.link) lines.push("", `Printable list: ${opts.link}`);
  return lines.join("\n");
}

export function mailtoHref(to: string | null, subject: string, body: string): string {
  const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${to ? encodeURIComponent(to).replace(/%40/g, "@") : ""}?${q}`;
}
