import { describe, expect, it } from "vitest";
import type { CueRow, NoteRow } from "../../../shared/tables";
import { emptyData, type ShowData } from "../../lib/show-state";
import {
  cueLinks,
  cycleType,
  findCue,
  initials,
  nextStatus,
  noteCreateOps,
  notesFor,
  parseNoteText,
  resolveLinks,
  sortNotes,
  subjectLinks,
} from "./compose";

const cue = (id: string, number: string | null, extra: Partial<CueRow> = {}) =>
  ({ id, number, is_section: false, scene_id: null, ...extra }) as CueRow;

const CUES = [
  cue("c1", "8.20"),
  cue("c2", "8.50"),
  cue("s", "8.5", { is_section: true }),
  cue("c3", "14.20"),
  cue("c4", "14.25A"),
  cue("c5", "8.5"), // a duplicate of 8.50, further down
];
const PERSONS = [
  { id: "p1", name: "Casey Brennan" },
  { id: "p2", name: "Morgan Ellis" },
  { id: "p3", name: "Morgan Fox" },
];
const ctx = { cues: CUES, currentCueId: "c3", persons: PERSONS };

describe("parseNoteText", () => {
  it("plain text goes to the current record", () => {
    expect(parseNoteText("  add grunge overlay ", ctx)).toEqual({
      body: "add grunge overlay",
      target: { kind: "current" },
      assigneeIds: [],
    });
  });

  it("a leading cue number links that cue instead (8.5 = 8.50)", () => {
    const p = parseNoteText("8.5 needs to be a fade", { ...ctx, currentCueId: "c1" });
    expect(p.target).toEqual({ kind: "cue", cueId: "c2", number: "8.50" });
    expect(p.body).toBe("needs to be a fade");
    // Letters and case: 14.25a = 14.25A.
    expect(parseNoteText("14.25a strobe", ctx).target).toMatchObject({ cueId: "c4" });
  });

  it("ambiguous numbers pick the cue nearest the current one in show order", () => {
    expect(parseNoteText("8.5 x", { ...ctx, currentCueId: "c1" }).target).toMatchObject({
      cueId: "c2",
    });
    expect(parseNoteText("8.5 x", { ...ctx, currentCueId: "c4" }).target).toMatchObject({
      cueId: "c5",
    });
    // No current cue: the first in show order. Sections never match.
    expect(findCue(CUES, "8.5", null)?.id).toBe("c2");
  });

  it("a number that isn't a cue stays in the text", () => {
    const p = parseNoteText("3 people in the wings", ctx);
    expect(p).toMatchObject({ body: "3 people in the wings", target: { kind: "current" } });
    // A number alone (no text after it) isn't a prefix.
    expect(parseNoteText("8.5", ctx).target).toEqual({ kind: "current" });
  });

  it("* makes a general note", () => {
    expect(parseNoteText("* order more haze", ctx)).toMatchObject({
      body: "order more haze",
      target: { kind: "general" },
    });
    expect(parseNoteText("*8.5 not a cue link", ctx)).toMatchObject({
      body: "8.5 not a cue link",
      target: { kind: "general" },
    });
  });

  it("@name assigns known people and leaves unknown mentions in the text", () => {
    const p = parseNoteText("fix edges @casey and @CaseyBrennan @nobody", ctx);
    expect(p.assigneeIds).toEqual(["p1"]);
    expect(p.body).toBe("fix edges and @nobody");
    // "Morgan" is ambiguous; the full name works.
    expect(parseNoteText("@morgan hi", ctx).assigneeIds).toEqual([]);
    expect(parseNoteText("@MorganFox hi", ctx).assigneeIds).toEqual(["p3"]);
    // Combined with a cue prefix.
    expect(parseNoteText("14.20 @morganellis check", ctx)).toMatchObject({
      body: "check",
      target: { kind: "cue", cueId: "c3" },
      assigneeIds: ["p2"],
    });
  });
});

describe("status and order", () => {
  it("cycles Open → In progress → Done → Open", () => {
    expect(nextStatus("Open")).toBe("In progress");
    expect(nextStatus("In progress")).toBe("Done");
    expect(nextStatus("Done")).toBe("Open");
    expect(nextStatus(null)).toBe("In progress");
  });

  it("sorts open first, then newest first", () => {
    const n = (id: string, status: string, created_at: number) => ({ id, status, created_at });
    expect(
      sortNotes([n("a", "Done", 5), n("b", "Open", 1), n("c", "In progress", 3)]).map((x) => x.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("cycles type chips with Tab", () => {
    const opts = ["Content", "Programming", "Director"];
    expect(cycleType(opts, [], 1)).toEqual(["Content"]);
    expect(cycleType(opts, ["Content", "Director"], 1)).toEqual(["Programming"]);
    expect(cycleType(opts, ["Director"], 1)).toEqual(["Content"]);
    expect(cycleType(opts, [], -1)).toEqual(["Director"]);
  });

  it("initials", () => {
    expect(initials("Casey Brennan")).toBe("CB");
    expect(initials("cher")).toBe("CH");
    expect(initials(" ")).toBe("?");
  });
});

function data(): ShowData {
  const d = emptyData();
  for (const c of [
    cue("c1", "1", { scene_id: "sc1" }),
    cue("c2", "2", { scene_id: "sc1" }),
    cue("c3", "3", { scene_id: "sc2" }),
  ])
    d.tables.cues.set(c.id, c);
  d.order.cues = ["c1", "c2", "c3"];
  d.tables.scenes.set("sc1", { id: "sc1" } as never);
  d.tables.content.set("k1", { id: "k1", scene_id: "sc1" } as never);
  d.joins.cueContent.set("c1", ["k1"]);
  d.joins.cueContent.set("c2", ["k1", "k2"]);
  const note = (id: string, extra: Partial<NoteRow>) =>
    ({ id, status: "Open", created_at: 1, scene_id: null, content_id: null, ...extra }) as NoteRow;
  d.tables.notes.set("n1", note("n1", { created_at: 1 }));
  d.tables.notes.set("n2", note("n2", { created_at: 2, content_id: "k1" }));
  d.tables.notes.set("n3", note("n3", { created_at: 3, status: "Done" }));
  d.tables.notes.set("n4", note("n4", { created_at: 4, scene_id: "sc1" }));
  d.joins.noteCues.set("n1", ["c1"]);
  d.joins.noteCues.set("n3", ["c1", "c3"]);
  return d;
}

describe("notes for a record and links for a new one", () => {
  it("selects a cue's, content's and scene's notes", () => {
    const d = data();
    const ids = (ns: { id: string }[]) => ns.map((n) => n.id);
    expect(ids(notesFor(d, { table: "cues", id: "c1" }))).toEqual(["n1", "n3"]);
    expect(ids(notesFor(d, { table: "content", id: "k1" }))).toEqual(["n2"]);
    expect(ids(notesFor(d, { table: "scenes", id: "sc1" }))).toEqual(["n4", "n1", "n3"]);
    expect(ids(notesFor(d, { table: "scenes", id: "sc1" }, { openOnly: true }))).toEqual([
      "n4",
      "n1",
    ]);
  });

  it("links a cue's content only when it has exactly one", () => {
    const d = data();
    expect(cueLinks(d, "c1")).toEqual({ cueIds: ["c1"], contentId: "k1", sceneId: "sc1" });
    expect(cueLinks(d, "c2")).toEqual({ cueIds: ["c2"], contentId: null, sceneId: "sc1" });
    expect(subjectLinks(d, { table: "content", id: "k1" })).toEqual({
      cueIds: [],
      contentId: "k1",
      sceneId: "sc1",
    });
    const base = subjectLinks(d, { table: "cues", id: "c2" });
    expect(resolveLinks(d, { kind: "general" }, base)).toEqual({
      cueIds: [],
      contentId: null,
      sceneId: null,
    });
    expect(resolveLinks(d, { kind: "cue", cueId: "c1", number: "1" }, base).cueIds).toEqual(["c1"]);
    expect(resolveLinks(d, { kind: "current" }, base)).toBe(base);
  });

  it("builds one batch: create, then cue and assignee links", () => {
    const ops = noteCreateOps(
      {
        body: "b",
        types: ["Content"],
        priority: "3",
        session: "Tech 2",
        links: { cueIds: ["c1"], contentId: "k1", sceneId: "sc1" },
        assigneeIds: ["p1", "p1", "p2"],
      },
      "n9",
    );
    expect(ops).toEqual([
      {
        op: "create",
        table: "notes",
        id: "n9",
        fields: {
          body: "b",
          type: ["Content"],
          priority: "3",
          status: "Open",
          session: "Tech 2",
          content_id: "k1",
          scene_id: "sc1",
        },
      },
      { op: "link", table: "notes", id: "n9", field: "cues", targetId: "c1", position: 0 },
      { op: "link", table: "notes", id: "n9", field: "assignees", targetId: "p1", position: 0 },
      { op: "link", table: "notes", id: "n9", field: "assignees", targetId: "p2", position: 1 },
    ]);
  });
});
