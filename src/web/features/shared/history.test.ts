import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../../shared/ops";
import { emptyData } from "../../lib/show-state";
import { fieldLabel, formatHistory, historySentence } from "./history";

const data = emptyData();
data.tables.scenes.set("s1", { id: "s1", number: "105", name: "Backstage" } as never);
data.tables.content.set("k1", { id: "k1", name: "105-001-VAMP" } as never);
data.tables.persons.set("p1", { id: "p1", name: "Casey Brennan" } as never);

const entry = (e: Partial<HistoryEntry>): HistoryEntry => ({
  version: 7,
  ts: 1000,
  userId: "u1",
  userName: "Ada",
  table: "cues",
  recordId: "c1",
  field: "description",
  old: null,
  new: null,
  clientId: null,
  ...e,
});

const labels = { description: "Description", scene: "Scene", content: "Content" };
const line = (e: Partial<HistoryEntry>) => historySentence(formatHistory(entry(e), data, labels));

describe("history lines", () => {
  it("field changes: who, field label, from → to", () => {
    const l = formatHistory(entry({ old: '"no change"', new: '"dim the room"' }), data, labels);
    expect(l).toMatchObject({
      who: "Ada",
      kind: "changed",
      field: "Description",
      from: "no change",
      to: "dim the room",
      when: 1000,
    });
    expect(historySentence(l)).toBe("Ada changed Description: no change → dim the room");
    expect(line({ old: null, new: '"x"' })).toBe("Ada changed Description: — → x");
  });

  it("created / deleted / moved", () => {
    expect(line({ field: "*", old: null, new: "{}" })).toBe("Ada created this");
    expect(line({ field: "*", old: "{}", new: null })).toBe("Ada deleted this");
    expect(line({ field: "order_key", old: '"a0"', new: '"a1"' })).toBe("Ada moved this");
  });

  it("resolves refs and link targets to labels", () => {
    expect(line({ field: "scene_id", old: null, new: '"s1"' })).toBe(
      "Ada changed Scene: — → 105 Backstage",
    );
    expect(line({ field: "content", new: '"k1"' })).toBe("Ada linked Content: 105-001-VAMP");
    expect(line({ field: "content", old: '"gone"' })).toBe(
      "Ada unlinked Content: (deleted content)",
    );
    expect(line({ table: "notes", field: "assignees", new: '"p1"' })).toBe(
      "Ada linked Assignees: Casey Brennan",
    );
    expect(
      line({ table: "notes", field: "type", old: '["Content"]', new: '["Content","Admin"]' }),
    ).toBe("Ada changed Type: Content → Content, Admin");
    expect(line({ field: "is_section", old: "false", new: "true" })).toBe(
      "Ada changed Is section: No → Yes",
    );
  });

  it("falls back to member names and readable field names", () => {
    const l = formatHistory(
      entry({ userName: null, field: "trigger_type", new: '"LX"' }),
      data,
      {},
      new Map([["u1", "Member Name"]]),
    );
    expect(historySentence(l)).toBe("Member Name changed Trigger type: — → LX");
    expect(fieldLabel("custom.mood", {})).toBe("Mood");
    expect(fieldLabel("creator_id", { creator: "Creator" })).toBe("Creator");
  });
});

describe("lengths and pixel sizes in history", () => {
  it("shows lengths in the active unit", () => {
    const e = entry({ table: "surfaces", field: "width", old: "4.5", new: "1.3716" });
    expect(formatHistory(e, data, {}, undefined, "ft-in")).toMatchObject({
      from: `14' 9 1/8"`,
      to: `4' 6"`,
    });
    expect(formatHistory(e, data, {})).toMatchObject({ from: "4.50 m", to: "1.37 m" });
    const px = entry({ table: "surfaces", field: "pixel_width", old: null, new: "1920" });
    expect(formatHistory(px, data, {}, undefined, "cm").to).toBe("1920");
  });
});
