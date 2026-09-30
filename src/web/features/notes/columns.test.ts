import { describe, expect, it } from "vitest";
import type { NoteRow } from "../../../shared/tables";
import {
  canEditNote,
  type NoteView,
  noteEditOps,
  statusFromGroupId,
  statusGroupId,
} from "./columns";

describe("notes", () => {
  it("commenters edit only their own notes; viewers none; editors all", () => {
    const mine = { created_by: "u1" };
    const theirs = { created_by: "u2" };
    expect(canEditNote("commenter", "u1", mine)).toBe(true);
    expect(canEditNote("commenter", "u1", theirs)).toBe(false);
    expect(canEditNote("viewer", "u1", mine)).toBe(false);
    expect(canEditNote("editor", "u1", theirs)).toBe(true);
    expect(canEditNote("owner", "u1", theirs)).toBe(true);
  });

  it("maps edits to ops", () => {
    const view = {
      id: "n1",
      note: { id: "n1" } as NoteRow,
      assignees: [{ id: "p1", label: "Casey" }],
      cues: [],
      content: null,
      scene: null,
      author: "",
      editable: true,
    } satisfies NoteView;
    expect(noteEditOps(view, "body", "")).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { body: null } },
    ]);
    // A note's session is editable on its own (it defaults to the show's current session).
    expect(noteEditOps(view, "session", "Preview 1")).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { session: "Preview 1" } },
    ]);
    expect(noteEditOps(view, "session", " ")).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { session: null } },
    ]);
    expect(noteEditOps(view, "type", ["Content"])).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { type: ["Content"] } },
    ]);
    expect(noteEditOps(view, "scene", { id: "s1", label: "101" })).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { scene_id: "s1" } },
    ]);
    expect(noteEditOps(view, "cues", [{ id: "c1", label: "1" }])).toEqual([
      { op: "link", table: "notes", id: "n1", field: "cues", targetId: "c1", position: 0 },
    ]);
    expect(noteEditOps(view, "assignees", [])).toEqual([
      { op: "unlink", table: "notes", id: "n1", field: "assignees", targetId: "p1" },
    ]);
  });

  it("status group ids round-trip", () => {
    expect(statusFromGroupId(statusGroupId("In progress"))).toBe("In progress");
    expect(statusFromGroupId(statusGroupId(null))).toBeNull();
    expect(statusFromGroupId(undefined)).toBeUndefined();
  });
});
