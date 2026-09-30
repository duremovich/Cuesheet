import { describe, expect, it } from "vitest";
import type { CueRow, NoteRow, PersonRow } from "../../../../shared/tables";
import { emptyData, type ShowData } from "../../../lib/show-state";
import { cssString, pageRule } from "../PrintShell";
import {
  groupByCue,
  groupByPerson,
  mailtoHref,
  NO_CUE_GROUP,
  noteRows,
  noteSessions,
  notesEmailBody,
  UNASSIGNED_GROUP,
} from "./notes";

const common = { custom: {}, created_by: "u", updated_at: 0, updated_by: "u" };

function cue(id: string, number: string, description: string | null = null): CueRow {
  return {
    ...common,
    id,
    created_at: 0,
    order_key: id,
    scene_id: null,
    number,
    description,
    trigger_type: null,
    trigger_value: null,
    sm_call: null,
    lx_cue: null,
    sq_cue: null,
    timecode: null,
    ae_time: null,
    measure: null,
    page: null,
    status: null,
    is_section: false,
  };
}

function person(id: string, name: string, email: string | null = null): PersonRow {
  return {
    ...common,
    id,
    created_at: 0,
    name,
    role: null,
    group: null,
    email,
    phone: null,
    organization: null,
    user_id: null,
  };
}

function note(id: string, body: string, created_at: number, extra: Partial<NoteRow> = {}): NoteRow {
  return {
    ...common,
    id,
    created_at,
    body,
    type: ["Content"],
    priority: null,
    status: "Open",
    content_id: null,
    scene_id: null,
    session: "Tech 1",
    completed_by: null,
    completed_at: null,
    ...extra,
  };
}

function show(): ShowData {
  const d = emptyData();
  for (const c of [cue("c1", "1", "Preshow"), cue("c2", "2"), cue("c3", "3")]) {
    d.tables.cues.set(c.id, c);
    d.order.cues.push(c.id);
  }
  for (const p of [person("pz", "Zoe", "zoe@x.test"), person("pa", "Abe")])
    d.tables.persons.set(p.id, p);
  const notes = [
    note("n1", "late cue 3", 1),
    note("n2", "fix cue 1", 2),
    note("n3", "done already", 3, { status: "Done" }),
    note("n4", "general", 4),
    note("n5", "tech 2 note", 5, { session: "Tech 2" }),
  ];
  for (const n of notes) d.tables.notes.set(n.id, n);
  d.joins.noteCues.set("n1", ["c3"]);
  d.joins.noteCues.set("n2", ["c1"]);
  d.joins.noteCues.set("n3", ["c1"]);
  d.joins.noteCues.set("n5", ["c2", "c1"]);
  d.joins.noteAssignees.set("n1", ["pz", "pa"]);
  d.joins.noteAssignees.set("n2", ["pz"]);
  d.joins.noteAssignees.set("n3", ["pz"]);
  return d;
}

describe("notes print presets", () => {
  it("filters by session and lists sessions in order", () => {
    const d = show();
    expect(noteSessions(d)).toEqual(["Tech 1", "Tech 2"]);
    expect(noteRows(d, "Tech 2").map((r) => r.note.id)).toEqual(["n5"]);
    expect(noteRows(d, null)).toHaveLength(5);
    // A note's cues come in show order.
    expect(noteRows(d, "Tech 2")[0]?.cues.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("by person: people by name, open first then cue order, unassigned last", () => {
    const groups = groupByPerson(noteRows(show(), "Tech 1"));
    expect(groups.map((g) => g.title)).toEqual(["Abe", "Zoe", "Unassigned"]);
    expect(groups[1]?.rows.map((r) => r.note.id)).toEqual(["n2", "n1", "n3"]);
    expect(groups[2]?.id).toBe(UNASSIGNED_GROUP);
    expect(groupByPerson(noteRows(show(), "Tech 1"), "pa").map((g) => g.title)).toEqual(["Abe"]);
  });

  it("by cue: cues in show order, a note under each of its cues, then no cue", () => {
    const groups = groupByCue(noteRows(show(), null), show());
    expect(groups.map((g) => g.title)).toEqual(["Q 1 · Preshow", "Q 2", "Q 3", "No cue"]);
    expect(groups[0]?.rows.map((r) => r.note.id)).toEqual(["n2", "n5", "n3"]);
    expect(groups.at(-1)?.id).toBe(NO_CUE_GROUP);
  });

  it("emails: a text body within the cap, the share link, a mailto", () => {
    const [, zoe] = groupByPerson(noteRows(show(), "Tech 1"));
    if (!zoe) throw new Error("no group");
    const body = notesEmailBody(zoe, {
      show: "Hot",
      session: "Tech 1",
      link: "https://c.test/s/abc?person=pz",
    });
    expect(body).toBe(
      [
        "Hot notes – Tech 1 for Zoe:",
        "",
        "- Q 1: fix cue 1",
        "- Q 3: late cue 3",
        "- Q 1: done already (done)",
        "",
        "Printable list: https://c.test/s/abc?person=pz",
      ].join("\n"),
    );
    const short = notesEmailBody(zoe, { show: "Hot", session: null, max: 40 });
    expect(short).toMatch(/…and 2 more\.$/);
    expect(mailtoHref("zoe@x.test", "Hot notes – Tech 1", "a b")).toBe(
      "mailto:zoe@x.test?subject=Hot%20notes%20%E2%80%93%20Tech%201&body=a%20b",
    );
  });

  it("page rules: running header/footer strings are escaped; page N of M", () => {
    expect(cssString('A "quoted" \\ name\n')).toBe('"A \\"quoted\\" \\\\ name "');
    const rule = pageRule("portrait", { title: "Show · Notes", footer: "Show · Tech 1" });
    expect(rule).toContain("size: portrait");
    expect(rule).toContain('@top-left { content: "Show · Notes"');
    expect(rule).toContain('"Page " counter(page) " of " counter(pages)');
  });
});
