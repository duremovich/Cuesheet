import { describe, expect, it } from "vitest";
import type { AttachmentRow } from "../../../shared/tables";
import {
  attachmentRestoreOps,
  attachmentsOf,
  fileLabel,
  hasThumbnail,
  positionAt,
  thumbnailOf,
} from "./selectors";

let seq = 0;
function file(fields: Partial<AttachmentRow>): AttachmentRow {
  seq++;
  return {
    id: `f${seq}`,
    custom: {},
    created_at: seq,
    created_by: "u",
    updated_at: seq,
    updated_by: "u",
    table: "content",
    record_id: "c1",
    field: "attachments",
    filename: `f${seq}.png`,
    content_type: "image/png",
    size: 10,
    r2_key: "k",
    width: null,
    height: null,
    thumb_key: null,
    position: seq,
    ...fields,
  };
}
const map = (rows: AttachmentRow[]) => new Map(rows.map((r) => [r.id, r]));

describe("attachment selectors", () => {
  it("a record's files in position order, the same array while nothing changes", () => {
    const a = file({ position: 2 });
    const b = file({ position: 1 });
    const other = file({ record_id: "c2" });
    const note = file({ table: "notes", record_id: "c1" });
    const files = map([a, b, other, note]);
    const list = attachmentsOf(files, "content", "c1");
    expect(list).toEqual([b, a]);
    expect(attachmentsOf(files, "content", "c1")).toBe(list);
    expect(attachmentsOf(files, "notes", "c1")).toEqual([note]);
    expect(attachmentsOf(files, "content", "none")).toEqual([]);
    expect(attachmentsOf(files, "content", "none")).toBe(attachmentsOf(files, "scenes", "x"));
  });

  it("the thumbnail is the first image, skipping other files", () => {
    const pdf = file({ content_type: "application/pdf", position: 1 });
    const img = file({ content_type: "image/jpeg", position: 2 });
    const later = file({ content_type: "image/png", position: 3 });
    expect(thumbnailOf(map([later, img, pdf]), "content", "c1")).toBe(img);
    expect(thumbnailOf(map([pdf]), "content", "c1")).toBeUndefined();
  });

  it("labels non-image files by kind", () => {
    expect(fileLabel({ content_type: "application/pdf", filename: "a.pdf" })).toBe("PDF");
    expect(fileLabel({ content_type: "video/mp4", filename: "a.mp4" })).toBe("Video");
    expect(fileLabel({ content_type: "application/zip", filename: "a.zip" })).toBe("ZIP");
  });

  it("positions a moved file between its new neighbours", () => {
    const [a, b, c] = [file({ position: 1 }), file({ position: 2 }), file({ position: 3 })];
    const list = [a, b, c] as AttachmentRow[];
    expect(positionAt(list, (c as AttachmentRow).id, 0)).toBe(0); // before a
    expect(positionAt(list, (a as AttachmentRow).id, 1)).toBe(2.5); // between b and c
    expect(positionAt(list, (a as AttachmentRow).id, 2)).toBe(4); // after c
    expect(positionAt([], "x", 0)).toBe(1);
  });

  it("Undo recreates deleted files with their ids, pointing at the same R2 objects", () => {
    const f = file({
      r2_key: "shows/s/f/a.png",
      custom: { original_size: { width: 1, height: 2 } },
    });
    expect(attachmentRestoreOps([f])).toEqual([
      {
        op: "create",
        table: "attachments",
        id: f.id,
        fields: {
          table: "content",
          record_id: "c1",
          field: "attachments",
          filename: f.filename,
          content_type: "image/png",
          size: 10,
          r2_key: "shows/s/f/a.png",
          width: null,
          height: null,
          thumb_key: null,
          position: f.position,
          custom: { original_size: { width: 1, height: 2 } },
        },
      },
    ]);
  });

  it("asks for a thumbnail only when the Worker has or can make one", () => {
    expect(hasThumbnail(file({ width: 4000, height: 3000 }))).toBe(true);
    expect(hasThumbnail(file({ width: 8000, height: 6000 }))).toBe(false);
    expect(hasThumbnail(file({ width: 8000, height: 6000, thumb_key: "k" }))).toBe(true);
    expect(hasThumbnail(file({ width: null, height: null }))).toBe(false);
    expect(hasThumbnail(file({ content_type: "application/pdf", width: 1, height: 1 }))).toBe(
      false,
    );
  });
});
