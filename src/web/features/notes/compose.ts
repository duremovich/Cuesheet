// The note compose grammar (R6, R7; ux.md §Tech mode) and the pure pieces of the notes
// panel: which notes belong to a record, their order, status cycling, and the ops for a
// new note.
//
//   "8.5 needs to be a fade"   → linked to cue 8.5 (= 8.50) instead of the current cue
//   "* order more haze"        → a general note: no cue, no content
//   "fix edges @Casey"         → assigned to Casey (the @picker does the same)
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { NoteRow } from "../../../shared/tables";
import type { ShowData } from "../../lib/show-state";
import { cueNumberKey } from "../cues/cueNumbers";

/** Where a note goes: the record the panel is about, no record, or a specific cue. */
export type NoteTarget =
  | { kind: "current" }
  | { kind: "general" }
  | { kind: "cue"; cueId: string; number: string };

export interface ParsedNote {
  body: string;
  target: NoteTarget;
  /** People named with `@name` in the text (removed from the body). */
  assigneeIds: string[];
}

interface CueLike {
  id: string;
  number: string | null;
  is_section: boolean;
}

interface PersonLike {
  id: string;
  name: string | null;
}

const CUE_PREFIX = /^(\d+(?:\.\d+)?[A-Za-z]?)\s+([\s\S]*)$/;
const MENTION = /(^|\s)@([^\s@]+)/g;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/**
 * The person an `@token` names: the full name without spaces ("@CaseyBrennan"), else a
 * unique first name ("@casey"). Case-insensitive.
 */
export function findPerson<P extends PersonLike>(
  persons: readonly P[],
  token: string,
): P | undefined {
  const t = token.toLowerCase();
  const full = persons.find((p) => p.name && squash(p.name) === t);
  if (full) return full;
  const first = persons.filter((p) => p.name?.trim().split(/\s+/)[0]?.toLowerCase() === t);
  return first.length === 1 ? first[0] : undefined;
}

/**
 * The cue a typed number names (14.2 = 14.20; "8.5a" = "8.5A"). Several matches (duplicate
 * numbers): the one nearest the current cue in show order, the earlier on a tie.
 */
export function findCue<C extends CueLike>(
  cues: readonly C[],
  number: string,
  currentCueId: string | null,
): C | undefined {
  const key = cueNumberKey(number);
  const matches: { cue: C; index: number }[] = [];
  let current = -1;
  cues.forEach((c, index) => {
    if (c.id === currentCueId) current = index;
    if (!c.is_section && c.number && cueNumberKey(c.number) === key)
      matches.push({ cue: c, index });
  });
  if (matches.length <= 1 || current < 0) return matches[0]?.cue;
  let best = matches[0] as { cue: C; index: number };
  for (const m of matches) {
    if (Math.abs(m.index - current) < Math.abs(best.index - current)) best = m;
  }
  return best.cue;
}

/** Parse what was typed in a compose box (see the file comment for the grammar). */
export function parseNoteText(
  text: string,
  ctx: { cues: readonly CueLike[]; currentCueId: string | null; persons: readonly PersonLike[] },
): ParsedNote {
  let rest = text.trim();
  let target: NoteTarget = { kind: "current" };
  if (rest.startsWith("*")) {
    target = { kind: "general" };
    rest = rest.slice(1).trim();
  } else {
    const m = CUE_PREFIX.exec(rest);
    const cue = m ? findCue(ctx.cues, m[1] as string, ctx.currentCueId) : undefined;
    if (m && cue) {
      target = { kind: "cue", cueId: cue.id, number: cue.number ?? (m[1] as string) };
      rest = (m[2] as string).trim();
    }
  }
  const assigneeIds: string[] = [];
  const body = rest
    .replace(MENTION, (whole, lead: string, token: string) => {
      const p = findPerson(ctx.persons, token);
      if (!p) return whole;
      if (!assigneeIds.includes(p.id)) assigneeIds.push(p.id);
      return lead;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { body, target, assigneeIds };
}

// ---- Status ----

export const NOTE_STATUSES = ["Open", "In progress", "Done"] as const;

/** Open → In progress → Done → Open (no status counts as Open). */
export function nextStatus(status: string | null | undefined): string {
  const i = NOTE_STATUSES.indexOf((status ?? "Open") as (typeof NOTE_STATUSES)[number]);
  return NOTE_STATUSES[(i + 1) % NOTE_STATUSES.length] as string;
}

export const isOpen = (n: Pick<NoteRow, "status">) => n.status !== "Done";

/** Open (and In progress) first, then newest first. */
export function sortNotes<N extends Pick<NoteRow, "status" | "created_at" | "id">>(
  notes: readonly N[],
): N[] {
  return [...notes].sort((a, b) => {
    const open = Number(isOpen(b)) - Number(isOpen(a));
    if (open) return open;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? 1 : -1;
  });
}

// ---- Which notes a record has ----

/** The record a notes panel is about. */
export type NotesSubject =
  | { table: "cues"; id: string }
  | { table: "content"; id: string }
  | { table: "scenes"; id: string };

/**
 * Notes about a record: a cue's linked notes; content's notes (`content_id`); a scene's
 * notes (its `scene_id`, or linked to one of its cues). `openOnly` drops Done notes.
 */
export function notesFor(
  data: ShowData,
  subject: NotesSubject,
  opts: { openOnly?: boolean } = {},
): NoteRow[] {
  const out: NoteRow[] = [];
  for (const n of data.tables.notes.values()) {
    if (opts.openOnly && !isOpen(n)) continue;
    const cues = data.joins.noteCues.get(n.id) ?? [];
    let hit = false;
    if (subject.table === "cues") hit = cues.includes(subject.id);
    else if (subject.table === "content") hit = n.content_id === subject.id;
    else {
      hit =
        n.scene_id === subject.id ||
        cues.some((c) => data.tables.cues.get(c)?.scene_id === subject.id);
    }
    if (hit) out.push(n);
  }
  return sortNotes(out);
}

/** Open notes per cue id (for counts in cue lists). */
export function openNoteCounts(data: ShowData): Map<string, number> {
  const out = new Map<string, number>();
  for (const [noteId, cues] of data.joins.noteCues) {
    const n = data.tables.notes.get(noteId);
    if (!n || !isOpen(n)) continue;
    for (const c of cues) out.set(c, (out.get(c) ?? 0) + 1);
  }
  return out;
}

// ---- New notes ----

export interface NoteLinks {
  cueIds: string[];
  contentId: string | null;
  sceneId: string | null;
}

export const NO_LINKS: NoteLinks = { cueIds: [], contentId: null, sceneId: null };

/** A cue's links for a note: the cue, its content when it has exactly one, its scene. */
export function cueLinks(data: ShowData, cueId: string): NoteLinks {
  const cue = data.tables.cues.get(cueId);
  const content = data.joins.cueContent.get(cueId) ?? [];
  return {
    cueIds: cue ? [cueId] : [],
    contentId: content.length === 1 ? (content[0] as string) : null,
    sceneId: cue?.scene_id ?? null,
  };
}

/** Links pre-filled by a panel about `subject` (no subject: a general note). */
export function subjectLinks(data: ShowData, subject: NotesSubject | null): NoteLinks {
  if (!subject) return NO_LINKS;
  if (subject.table === "cues") return cueLinks(data, subject.id);
  if (subject.table === "content") {
    const c = data.tables.content.get(subject.id);
    return { cueIds: [], contentId: c ? c.id : null, sceneId: c?.scene_id ?? null };
  }
  return {
    cueIds: [],
    contentId: null,
    sceneId: data.tables.scenes.has(subject.id) ? subject.id : null,
  };
}

/** The links a parsed note ends up with. */
export function resolveLinks(data: ShowData, target: NoteTarget, base: NoteLinks): NoteLinks {
  if (target.kind === "general") return NO_LINKS;
  if (target.kind === "cue") return cueLinks(data, target.cueId);
  return base;
}

export interface NewNote {
  body: string;
  types: readonly string[];
  priority: string | null;
  session: string | null;
  links: NoteLinks;
  assigneeIds: readonly string[];
}

/** One batch: the note (status Open), then its cue and assignee links. */
export function noteCreateOps(note: NewNote, id: string = newId()): Op[] {
  const ops: Op[] = [
    {
      op: "create",
      table: "notes",
      id,
      fields: {
        body: note.body,
        type: [...note.types],
        priority: note.priority,
        status: "Open",
        session: note.session,
        content_id: note.links.contentId,
        scene_id: note.links.sceneId,
      },
    },
  ];
  note.links.cueIds.forEach((targetId, position) => {
    ops.push({ op: "link", table: "notes", id, field: "cues", targetId, position });
  });
  [...new Set(note.assigneeIds)].forEach((targetId, position) => {
    ops.push({ op: "link", table: "notes", id, field: "assignees", targetId, position });
  });
  return ops;
}

/** Tab / Shift+Tab in tech mode: step the single selected type through the options. */
export function cycleType(
  options: readonly string[],
  selected: readonly string[],
  delta: 1 | -1,
): string[] {
  if (options.length === 0) return [...selected];
  const at = selected.length ? options.indexOf(selected[0] as string) : -1;
  const next = at < 0 ? (delta === 1 ? 0 : options.length - 1) : at + delta;
  const wrapped = (next + options.length) % options.length;
  return [options[wrapped] as string];
}

/** "Casey Brennan" → "CB"; "Casey" → "CA"; "" → "?". */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0]}${(parts.at(-1) as string)[0]}`.toUpperCase();
}
