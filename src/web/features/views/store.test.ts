// The client side of the views table: ordering/visibility (viewsFor) and the optimistic
// default exclusivity (resolveLocal mirrors the server).
import { describe, expect, it } from "vitest";
import type { ViewRow } from "../../../shared/tables";
import { defaultViewConfig } from "../../../shared/views";
import { applyResolved, emptyData, resolveLocal } from "../../lib/show-state";
import { viewsFor } from "../../lib/show-store";

const view = (id: string, patch: Partial<ViewRow> = {}): ViewRow => ({
  id,
  table: "cues",
  name: id,
  owner_user_id: null,
  is_default: false,
  position: 0,
  config: defaultViewConfig("cues") as unknown as ViewRow["config"],
  custom: {},
  created_at: 1,
  created_by: "u",
  updated_at: 1,
  updated_by: "u",
  ...patch,
});

describe("viewsFor", () => {
  it("shared views then mine (by position, then age); others' personal views left out", () => {
    const rows = new Map(
      [
        view("b", { position: 2 }),
        view("a", { position: 1 }),
        view("mine", { owner_user_id: "me" }),
        view("theirs", { owner_user_id: "them" }),
        view("notes", { table: "notes" }),
      ].map((v) => [v.id, v]),
    );
    const out = viewsFor(rows, "cues", "me");
    expect(out.shared.map((v) => v.id)).toEqual(["a", "b"]);
    expect(out.mine.map((v) => v.id)).toEqual(["mine"]);
  });
});

describe("optimistic is_default", () => {
  it("setting a shared default clears the table's other shared defaults locally", () => {
    let data = emptyData();
    data = applyResolved(data, [
      { op: "create", table: "views", id: "v1", fields: { ...view("v1", { is_default: true }) } },
      { op: "create", table: "views", id: "v2", fields: { ...view("v2") } },
      {
        op: "create",
        table: "views",
        id: "n1",
        fields: { ...view("n1", { table: "notes", is_default: true }) },
      },
    ]);
    const ops = resolveLocal(
      data,
      [{ op: "update", table: "views", id: "v2", fields: { is_default: true } }],
      { userId: "u", now: 2 },
    );
    expect(
      ops.map((o) => [
        o.op,
        "id" in o ? o.id : null,
        "table" in o && "fields" in o ? o.fields.is_default : null,
      ]),
    ).toEqual([
      ["update", "v2", true],
      ["update", "v1", false],
    ]);
  });
});
