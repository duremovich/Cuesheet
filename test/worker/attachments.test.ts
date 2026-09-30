// Attachments (R13, S4): upload-url → PUT into R2 → row through the op engine; download,
// thumbnails (Photon), roles, types, sizes, the per-show storage cap, and cleanup of R2
// objects when rows (or their records) are deleted.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";
import { describe, expect, it } from "vitest";
import type { UploadUrlResponse } from "../../src/shared/api";
import {
  imageSize,
  MAX_ATTACHMENT_BYTES,
  SHOW_STORAGE_LIMIT_BYTES,
  thumbnailKey,
} from "../../src/shared/attachments";
import { newId } from "../../src/shared/ids";
import type { MutateResponse, Op, SnapshotResponse } from "../../src/shared/ops";
import type { AttachmentRow } from "../../src/shared/tables";
import { parseRange } from "../../src/worker/routes/attachments";
import { api, createShow, loginAdmin, newUser, post } from "./helpers";

// ---- a tiny PNG encoder (RGB, 8 bit) so tests can make images of any size ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function png(width: number, height: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 200;
      raw[o + 1] = (x * 4) & 255;
      raw[o + 2] = (y * 4) & 255;
    }
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A JPEG w×h (left half red, right half blue) with an EXIF Orientation tag, like a phone
 * photo taken sideways (6: turn 90° clockwise to view).
 */
function orientedJpeg(w: number, h: number, orientation: number): Uint8Array {
  const raw = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const left = x < w / 2;
      raw.set(left ? [230, 20, 20, 255] : [20, 20, 230, 255], o);
    }
  }
  const img = new PhotonImage(raw, w, h);
  const jpeg = img.get_bytes_jpeg(90);
  img.free();
  // APP1 "Exif\0\0" + big-endian TIFF with one IFD entry: 0x0112 SHORT 1 = orientation.
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
  const payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const len = payload.length + 2;
  const app1 = [0xff, 0xe1, len >> 8, len & 0xff, ...payload];
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

// ---- helpers ----
async function setup() {
  const admin = await loginAdmin();
  const show = await createShow(admin, "Attachments");
  const content = newId();
  const res = await mutate(show.id, admin, [
    { op: "create", table: "content", id: content, fields: { name: "105-001-VAMP" } },
  ]);
  expect(res.status).toBe(200);
  return { admin, showId: show.id, content };
}

function mutate(showId: string, cookie: string, ops: Op[]) {
  return post(`/api/shows/${showId}/mutate`, { clientId: "t", ops }, cookie);
}

async function addMember(showId: string, admin: string, role: "editor" | "commenter" | "viewer") {
  const user = await newUser(admin, role);
  const res = await post(`/api/shows/${showId}/members`, { email: user.email, role }, admin);
  expect(res.status).toBe(201);
  return user;
}

function uploadUrl(showId: string, cookie: string, body: Record<string, unknown>) {
  return post(`/api/shows/${showId}/attachments/upload-url`, body, cookie);
}

async function uploadFile(
  showId: string,
  cookie: string,
  target: { table: string; recordId: string },
  file: { name: string; type: string; bytes: Uint8Array },
) {
  const r = await uploadUrl(showId, cookie, {
    ...target,
    filename: file.name,
    contentType: file.type,
    size: file.bytes.length,
  });
  expect(r.status, await r.clone().text()).toBe(200);
  const reserved = (await r.json()) as UploadUrlResponse;
  const put = await api(reserved.uploadUrl, {
    method: "PUT",
    cookie,
    headers: { "Content-Type": reserved.contentType },
    body: file.bytes,
  });
  return { reserved, put };
}

async function snapshot(showId: string, cookie: string) {
  return (await (
    await api(`/api/shows/${showId}/snapshot`, { cookie })
  ).json()) as SnapshotResponse;
}

async function used(showId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT storage_bytes AS n FROM shows WHERE id = ?")
    .bind(showId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

/** What the client's Undo sends to recreate a deleted attachment (attachmentRestoreOps). */
function restoreFields(f: AttachmentRow) {
  const { table, record_id, field, filename, content_type, size, r2_key, width, height } = f;
  return {
    table,
    record_id,
    field,
    filename,
    content_type,
    size,
    r2_key,
    width,
    height,
    thumb_key: f.thumb_key,
    position: f.position,
    custom: f.custom,
  };
}

/** Attachment ids whose R2 files wait for the purge alarm. */
async function pending(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, (_i, s) =>
    s.storage.sql
      .exec<{ id: string }>("SELECT attachment_id AS id FROM pending_r2_deletes")
      .toArray()
      .map((r) => r.id),
  );
}

describe("attachments", () => {
  it("uploads a PNG into R2, records it, serves it and its thumbnail", async () => {
    const { admin, showId, content } = await setup();
    const bytes = await png(640, 480);
    const { reserved, put } = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "still.png", type: "image/png", bytes },
    );
    expect(put.status, await put.clone().text()).toBe(201);
    const { attachment } = (await put.json()) as { attachment: AttachmentRow };
    expect(attachment).toMatchObject({
      id: reserved.attachmentId,
      table: "content",
      record_id: content,
      field: "attachments",
      filename: "still.png",
      content_type: "image/png",
      size: bytes.length,
      width: 640,
      height: 480,
      position: 1,
      r2_key: `shows/${showId}/${reserved.attachmentId}/still.png`,
    });
    expect(await env.FILES.head(attachment.r2_key)).not.toBeNull();
    expect(await used(showId)).toBe(bytes.length);
    const snap = await snapshot(showId, admin);
    expect(snap.tables.attachments.map((a) => a.id)).toEqual([reserved.attachmentId]);
    // History: a create like any other row.
    const hist = (await (
      await api(`/api/shows/${showId}/history?table=attachments&id=${attachment.id}`, {
        cookie: admin,
      })
    ).json()) as { changes: { field: string }[] };
    expect(hist.changes.map((c) => c.field)).toEqual(["*"]);

    const file = await api(reserved.uploadUrl, { cookie: admin });
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(file.headers.get("Cache-Control")).toMatch(/max-age/);
    expect(file.headers.get("Content-Disposition")).toMatch(/^inline;.*still\.png/);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    const etag = file.headers.get("ETag") ?? "";
    const again = await api(reserved.uploadUrl, {
      cookie: admin,
      headers: { "If-None-Match": etag },
    });
    expect(again.status).toBe(304);
    const dl = await api(`${reserved.uploadUrl}?download=1`, { cookie: admin });
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    await dl.arrayBuffer();

    const thumb = await api(`${reserved.uploadUrl}/thumb`, { cookie: admin });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/png");
    const tb = new Uint8Array(await thumb.arrayBuffer());
    expect(imageSize(tb)).toEqual({ width: 320, height: 240 });
    expect(await env.FILES.head(thumbnailKey(showId, attachment.id))).not.toBeNull();
    // Second request: from R2.
    const thumb2 = await api(`${reserved.uploadUrl}/thumb`, { cookie: admin });
    expect(new Uint8Array(await thumb2.arrayBuffer())).toEqual(tb);

    // A second file goes after the first.
    const second = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") },
    );
    expect(second.put.status).toBe(201);
    expect(((await second.put.json()) as { attachment: AttachmentRow }).attachment.position).toBe(
      2,
    );
    // No thumbnails for non-images.
    const noThumb = await api(`${second.reserved.uploadUrl}/thumb`, { cookie: admin });
    expect(noThumb.status).toBe(404);
    await noThumb.arrayBuffer();
  });

  it("refuses unsupported types, HEIC, oversize files and bad targets", async () => {
    const { admin, showId, content } = await setup();
    const base = { table: "content", recordId: content, size: 10 };
    const heic = await uploadUrl(showId, admin, {
      ...base,
      filename: "IMG.HEIC",
      contentType: "image/heic",
    });
    expect(heic.status).toBe(415);
    expect(((await heic.json()) as { error: string }).error).toMatch(/HEIC/);
    const exe = await uploadUrl(showId, admin, {
      ...base,
      filename: "x.exe",
      contentType: "application/x-msdownload",
    });
    expect(exe.status).toBe(415);
    await exe.arrayBuffer();
    const svg = await uploadUrl(showId, admin, {
      ...base,
      filename: "x.svg",
      contentType: "image/svg+xml",
    });
    expect(svg.status).toBe(415);
    await svg.arrayBuffer();
    const big = await uploadUrl(showId, admin, {
      ...base,
      size: MAX_ATTACHMENT_BYTES + 1,
      filename: "big.mp4",
      contentType: "video/mp4",
    });
    expect(big.status).toBe(413);
    await big.arrayBuffer();
    // A known extension without a type is fine.
    const byExt = await uploadUrl(showId, admin, {
      ...base,
      filename: "clip.mov",
      contentType: "",
    });
    expect(byExt.status).toBe(200);
    expect(((await byExt.json()) as UploadUrlResponse).contentType).toBe("video/quicktime");
    for (const bad of [
      { ...base, table: "cues", filename: "a.png", contentType: "image/png" },
      { ...base, field: "photos", filename: "a.png", contentType: "image/png" },
    ]) {
      const r = await uploadUrl(showId, admin, bad);
      expect(r.status).toBe(400);
      await r.arrayBuffer();
    }
    const missing = await uploadUrl(showId, admin, {
      ...base,
      recordId: newId(),
      filename: "a.png",
      contentType: "image/png",
    });
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    // Empty files are refused.
    const empty = await uploadUrl(showId, admin, {
      ...base,
      size: 0,
      filename: "a.txt",
      contentType: "text/plain",
    });
    expect(empty.status).toBe(400);
    await empty.arrayBuffer();

    // PUT: over the size limit, missing length, unknown or someone else's reservation, a
    // body that isn't the size reserved.
    const ok = (await (
      await uploadUrl(showId, admin, {
        ...base,
        size: 5,
        filename: "a.txt",
        contentType: "text/plain",
      })
    ).json()) as UploadUrlResponse;
    const other = (await (
      await uploadUrl(showId, admin, {
        ...base,
        size: 5,
        filename: "b.txt",
        contentType: "text/plain",
      })
    ).json()) as UploadUrlResponse;
    const wrongSize = await api(other.uploadUrl, { method: "PUT", cookie: admin, body: "hello!!" });
    expect(wrongSize.status).toBe(400);
    expect(((await wrongSize.json()) as { error: string }).error).toMatch(/7 bytes but 5/);
    const tooLong = await api(ok.uploadUrl, {
      method: "PUT",
      cookie: admin,
      headers: { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) },
      body: "x",
    });
    expect(tooLong.status).toBe(413);
    await tooLong.arrayBuffer();
    const editor = await addMember(showId, admin, "editor");
    const stolen = await api(ok.uploadUrl, { method: "PUT", cookie: editor.cookie, body: "hello" });
    expect(stolen.status).toBe(404);
    await stolen.arrayBuffer();
    const unknown = await api(`/api/shows/${showId}/attachments/${newId()}`, {
      method: "PUT",
      cookie: admin,
      body: "hello",
    });
    expect(unknown.status).toBe(404);
    await unknown.arrayBuffer();
    // The reservation is still the admin's, and claimed once.
    const put = await api(ok.uploadUrl, { method: "PUT", cookie: admin, body: "hello" });
    expect(put.status).toBe(201);
    await put.arrayBuffer();
    const twice = await api(ok.uploadUrl, { method: "PUT", cookie: admin, body: "hello" });
    expect(twice.status).toBe(404);
    await twice.arrayBuffer();
  });

  it("roles: viewers read only, commenters attach to their own notes, non-members see nothing", async () => {
    const { admin, showId, content } = await setup();
    const { put, reserved } = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "a.png", type: "image/png", bytes: await png(8, 6) },
    );
    expect(put.status).toBe(201);
    await put.arrayBuffer();

    const viewer = await addMember(showId, admin, "viewer");
    const v = await uploadUrl(showId, viewer.cookie, {
      table: "content",
      recordId: content,
      filename: "b.png",
      contentType: "image/png",
      size: 10,
    });
    expect(v.status).toBe(403);
    await v.arrayBuffer();
    const view = await api(reserved.uploadUrl, { cookie: viewer.cookie });
    expect(view.status).toBe(200);
    await view.arrayBuffer();
    // A small image is its own thumbnail.
    const vt = await api(`${reserved.uploadUrl}/thumb`, { cookie: viewer.cookie });
    expect(vt.status).toBe(200);
    expect(imageSize(new Uint8Array(await vt.arrayBuffer()))).toEqual({ width: 8, height: 6 });
    const del = await mutate(showId, viewer.cookie, [
      { op: "delete", table: "attachments", id: reserved.attachmentId },
    ]);
    expect(del.status).toBe(403);
    await del.arrayBuffer();

    const stranger = await newUser(admin, "Stranger");
    const hidden = await api(reserved.uploadUrl, { cookie: stranger.cookie });
    expect(hidden.status).toBe(404);
    await hidden.arrayBuffer();

    const commenter = await addMember(showId, admin, "commenter");
    const own = newId();
    const theirs = newId();
    expect(
      (
        await mutate(showId, commenter.cookie, [
          { op: "create", table: "notes", id: own, fields: { body: "mine" } },
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await mutate(showId, admin, [
          { op: "create", table: "notes", id: theirs, fields: { body: "admin's" } },
        ])
      ).status,
    ).toBe(200);
    const mine = await uploadFile(
      showId,
      commenter.cookie,
      { table: "notes", recordId: own },
      { name: "stage.png", type: "image/png", bytes: await png(8, 6) },
    );
    expect(mine.put.status).toBe(201);
    await mine.put.arrayBuffer();
    for (const target of [
      { table: "notes", recordId: theirs },
      { table: "content", recordId: content },
    ]) {
      const r = await uploadUrl(showId, commenter.cookie, {
        ...target,
        filename: "x.png",
        contentType: "image/png",
        size: 10,
      });
      expect(r.status).toBe(403);
      await r.arrayBuffer();
    }
    // They may delete their own note's file, not others'.
    const theirsFile = await mutate(showId, commenter.cookie, [
      { op: "delete", table: "attachments", id: reserved.attachmentId },
    ]);
    expect(theirsFile.status).toBe(403);
    await theirsFile.arrayBuffer();
    const ownFile = await mutate(showId, commenter.cookie, [
      { op: "delete", table: "attachments", id: mine.reserved.attachmentId },
    ]);
    expect(ownFile.status).toBe(200);
    await ownFile.arrayBuffer();
  });

  it("clients can't create attachment rows; they may reorder them", async () => {
    const { admin, showId, content } = await setup();
    const forged = await mutate(showId, admin, [
      {
        op: "create",
        table: "attachments",
        id: newId(),
        fields: {
          table: "content",
          record_id: content,
          field: "attachments",
          position: 1,
        },
      },
    ]);
    expect(forged.status).toBe(403);
    await forged.arrayBuffer();
    const { put, reserved } = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "a.txt", type: "text/plain", bytes: new TextEncoder().encode("a") },
    );
    await put.arrayBuffer();
    const move = await mutate(showId, admin, [
      { op: "update", table: "attachments", id: reserved.attachmentId, fields: { position: 0.5 } },
    ]);
    expect(move.status).toBe(200);
    await move.arrayBuffer();
    const rename = await mutate(showId, admin, [
      { op: "update", table: "attachments", id: reserved.attachmentId, fields: { r2_key: "x" } },
    ]);
    expect(rename.status).toBe(400);
    await rename.arrayBuffer();
  });

  it("deletes keep the files for a day: Undo restores them; the alarm purges and frees storage", async () => {
    const { admin, showId, content } = await setup();
    const a = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "a.png", type: "image/png", bytes: await png(400, 300) },
    );
    const b = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "b.txt", type: "text/plain", bytes: new TextEncoder().encode("bee") },
    );
    const rowA = ((await a.put.json()) as { attachment: AttachmentRow }).attachment;
    const rowB = ((await b.put.json()) as { attachment: AttachmentRow }).attachment;
    await (await api(`${a.reserved.uploadUrl}/thumb`, { cookie: admin })).arrayBuffer();
    expect(await env.FILES.head(thumbnailKey(showId, rowA.id))).not.toBeNull();
    expect(await used(showId)).toBe(rowA.size + rowB.size);
    const stub = env.SHOW.get(env.SHOW.idFromName(showId));

    // Delete: the row goes at once; the file, its thumbnail and the bytes stay (for Undo).
    const del = await mutate(showId, admin, [{ op: "delete", table: "attachments", id: rowA.id }]);
    expect(del.status).toBe(200);
    await del.arrayBuffer();
    expect(await env.FILES.head(rowA.r2_key)).not.toBeNull();
    expect(await used(showId)).toBe(rowA.size + rowB.size);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();

    // Undo: the row comes back exactly as it was deleted (same id, same file); whatever
    // fields the client sends are ignored, so it can't point the row at another object.
    const fields = restoreFields(rowA);
    const undo = await mutate(showId, admin, [
      {
        op: "create",
        table: "attachments",
        id: rowA.id,
        fields: { ...fields, r2_key: `shows/${showId}/other/x.png`, filename: "evil.exe" },
      },
    ]);
    expect(undo.status, await undo.clone().text()).toBe(200);
    await undo.arrayBuffer();
    const restored = (await snapshot(showId, admin)).tables.attachments.find(
      (f) => f.id === rowA.id,
    );
    expect(restored).toMatchObject({
      r2_key: rowA.r2_key,
      filename: "a.png",
      size: rowA.size,
      position: rowA.position,
      width: 400,
      height: 300,
    });
    const back = await api(a.reserved.uploadUrl, { cookie: admin });
    expect(back.status).toBe(200);
    await back.arrayBuffer();
    expect(await pending(stub)).toEqual([]);

    // Deleting the content cascades to its attachments (explicit delete ops first).
    const res = await mutate(showId, admin, [{ op: "delete", table: "content", id: content }]);
    const body = (await res.json()) as MutateResponse;
    expect(body.ops.map((o) => (o.op === "meta" ? [o.op] : [o.op, o.table]))).toEqual([
      ["delete", "attachments"],
      ["delete", "attachments"],
      ["delete", "content"],
    ]);
    expect((await pending(stub)).sort()).toEqual([rowA.id, rowB.id].sort());

    // The alarm before a day has passed purges nothing and stays scheduled.
    await runDurableObjectAlarm(stub);
    expect(await env.FILES.head(rowA.r2_key)).not.toBeNull();
    expect(await used(showId)).toBe(rowA.size + rowB.size);
    // A day later (backdated): files and thumbnails go, and so do the bytes.
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec(
        "UPDATE pending_r2_deletes SET deleted_at = deleted_at - ?",
        25 * 60 * 60 * 1000,
      );
      return s.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await env.FILES.head(rowA.r2_key)).toBeNull();
    expect(await env.FILES.head(rowB.r2_key)).toBeNull();
    expect(await env.FILES.head(thumbnailKey(showId, rowA.id))).toBeNull();
    expect(await used(showId)).toBe(0);
    expect(await pending(stub)).toEqual([]);
    // Nothing left to purge: no alarm.
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();

    // Too late to restore: the file is gone, so the row can't come back.
    const late = await mutate(showId, admin, [
      { op: "create", table: "content", id: content, fields: {} },
      { op: "create", table: "attachments", id: rowB.id, fields: restoreFields(rowB) },
    ]);
    expect(late.status).toBe(403);
    await late.arrayBuffer();
  });

  it("Undo of a deleted note brings its photos back (commenter, own note)", async () => {
    const { admin, showId } = await setup();
    const commenter = await addMember(showId, admin, "commenter");
    const note = newId();
    expect(
      (
        await mutate(showId, commenter.cookie, [
          { op: "create", table: "notes", id: note, fields: { body: "haze" } },
        ])
      ).status,
    ).toBe(200);
    const up = await uploadFile(
      showId,
      commenter.cookie,
      { table: "notes", recordId: note },
      { name: "stage.png", type: "image/png", bytes: await png(8, 6) },
    );
    const photo = ((await up.put.json()) as { attachment: AttachmentRow }).attachment;
    const del = await mutate(showId, commenter.cookie, [
      { op: "delete", table: "notes", id: note },
    ]);
    expect(del.status).toBe(200);
    await del.arrayBuffer();
    const fields = restoreFields(photo);
    const undo = await mutate(showId, commenter.cookie, [
      { op: "create", table: "notes", id: note, fields: { body: "haze" } },
      { op: "create", table: "attachments", id: photo.id, fields },
    ]);
    expect(undo.status, await undo.clone().text()).toBe(200);
    await undo.arrayBuffer();
    const snap = await snapshot(showId, admin);
    expect(snap.tables.attachments.map((f) => [f.id, f.record_id])).toEqual([[photo.id, note]]);
  });

  it("keeps the original size of a photo the client scaled down", async () => {
    const { admin, showId, content } = await setup();
    const bytes = await png(40, 30);
    const r = await uploadUrl(showId, admin, {
      table: "content",
      recordId: content,
      filename: "big.png",
      contentType: "image/png",
      size: bytes.length,
      originalSize: { width: 8000, height: 6000 },
    });
    const reserved = (await r.json()) as UploadUrlResponse;
    const put = await api(reserved.uploadUrl, { method: "PUT", cookie: admin, body: bytes });
    const { attachment } = (await put.json()) as { attachment: AttachmentRow };
    expect(attachment).toMatchObject({
      width: 40,
      height: 30,
      custom: { original_size: { width: 8000, height: 6000 } },
    });
  });

  it("caps a show's storage at 2 GB and reports usage", async () => {
    const { admin, showId, content } = await setup();
    const early = (await (
      await uploadUrl(showId, admin, {
        table: "content",
        recordId: content,
        filename: "a.txt",
        contentType: "text/plain",
        size: 5,
      })
    ).json()) as UploadUrlResponse;
    await env.DB.prepare("UPDATE shows SET storage_bytes = ? WHERE id = ?")
      .bind(SHOW_STORAGE_LIMIT_BYTES - 3, showId)
      .run();
    const r = await uploadUrl(showId, admin, {
      table: "content",
      recordId: content,
      filename: "a.txt",
      contentType: "text/plain",
      size: 5,
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toMatch(/storage is full/);
    // A reservation made before the show filled up is refused at PUT, and nothing is kept.
    const put = await api(early.uploadUrl, { method: "PUT", cookie: admin, body: "hello" });
    expect(put.status).toBe(413);
    await put.arrayBuffer();
    expect(await used(showId)).toBe(SHOW_STORAGE_LIMIT_BYTES - 3);
    const storage = await api(`/api/shows/${showId}/storage`, { cookie: admin });
    expect(await storage.json()).toEqual({
      usedBytes: SHOW_STORAGE_LIMIT_BYTES - 3,
      limitBytes: SHOW_STORAGE_LIMIT_BYTES,
    });
  });

  it("an upload whose record was deleted meanwhile is rolled back", async () => {
    const { admin, showId, content } = await setup();
    const reserved = (await (
      await uploadUrl(showId, admin, {
        table: "content",
        recordId: content,
        filename: "a.txt",
        contentType: "text/plain",
        size: 5,
      })
    ).json()) as UploadUrlResponse;
    await (
      await mutate(showId, admin, [{ op: "delete", table: "content", id: content }])
    ).arrayBuffer();
    const put = await api(reserved.uploadUrl, { method: "PUT", cookie: admin, body: "hello" });
    expect(put.status).toBe(404);
    await put.arrayBuffer();
    expect(await used(showId)).toBe(0);
    const listed = await env.FILES.list({ prefix: `shows/${showId}/` });
    expect(listed.objects).toHaveLength(0);
  });
  it("applies EXIF orientation: size stored upright, thumbnail turned (Orientation=6)", async () => {
    const { admin, showId, content } = await setup();
    const bytes = orientedJpeg(800, 400, 6);
    const { put, reserved } = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "phone.jpg", type: "image/jpeg", bytes },
    );
    expect(put.status).toBe(201);
    const { attachment } = (await put.json()) as { attachment: AttachmentRow };
    expect(attachment).toMatchObject({ width: 400, height: 800 });
    const thumb = await api(`${reserved.uploadUrl}/thumb`, { cookie: admin });
    expect(thumb.status).toBe(200);
    const tb = new Uint8Array(await thumb.arrayBuffer());
    expect(imageSize(tb)).toEqual({ width: 160, height: 320 });
    // Turned clockwise: the picture's left half (red) is now on top, the right (blue) below.
    const img = PhotonImage.new_from_byteslice(tb);
    const px = img.get_raw_pixels();
    const at = (x: number, y: number) =>
      Array.from(px.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 3));
    img.free();
    const [r1, , b1] = at(80, 20) as [number, number, number];
    const [r2, , b2] = at(80, 300) as [number, number, number];
    expect(r1 - b1).toBeGreaterThan(80); // red on top
    expect(b2 - r2).toBeGreaterThan(80); // blue below
  });

  it("restores only as it was, and only for whoever may attach to its record", async () => {
    const { admin, showId } = await setup();
    const note = newId();
    await (
      await mutate(showId, admin, [
        { op: "create", table: "notes", id: note, fields: { body: "x" } },
      ])
    ).arrayBuffer();
    const up = await uploadFile(
      showId,
      admin,
      { table: "notes", recordId: note },
      { name: "a.png", type: "image/png", bytes: await png(8, 6) },
    );
    const row = ((await up.put.json()) as { attachment: AttachmentRow }).attachment;
    await (
      await mutate(showId, admin, [{ op: "delete", table: "attachments", id: row.id }])
    ).arrayBuffer();
    // A commenter can't bring back a file on someone else's note, whatever they claim.
    const commenter = await addMember(showId, admin, "commenter");
    const own = newId();
    await (
      await mutate(showId, commenter.cookie, [
        { op: "create", table: "notes", id: own, fields: { body: "mine" } },
      ])
    ).arrayBuffer();
    const claim = await mutate(showId, commenter.cookie, [
      {
        op: "create",
        table: "attachments",
        id: row.id,
        fields: { ...restoreFields(row), record_id: own },
      },
    ]);
    expect(claim.status).toBe(403);
    await claim.arrayBuffer();
    const restored = await mutate(showId, admin, [
      { op: "create", table: "attachments", id: row.id, fields: {} },
    ]);
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
    const snap = await snapshot(showId, admin);
    expect(snap.tables.attachments.find((f) => f.id === row.id)?.record_id).toBe(note);

    // History never shows the R2 key.
    const hist = (await (
      await api(`/api/shows/${showId}/history?table=attachments&id=${row.id}`, { cookie: admin })
    ).json()) as { changes: { field: string; old: string | null; new: string | null }[] };
    expect(hist.changes).toHaveLength(3);
    for (const ch of hist.changes) {
      expect(ch.old ?? "").not.toContain("r2_key");
      expect(ch.new ?? "").not.toContain("r2_key");
    }
    expect(hist.changes.some((ch) => (ch.new ?? "").includes('"filename":"a.png"'))).toBe(true);
  });

  it("serves byte ranges (video seeking, PDF viewers)", async () => {
    const { admin, showId, content } = await setup();
    const bytes = new TextEncoder().encode("0123456789");
    const { put, reserved } = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "clip.txt", type: "text/plain", bytes },
    );
    await put.arrayBuffer();
    const whole = await api(reserved.uploadUrl, { cookie: admin });
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    await whole.arrayBuffer();
    const part = await api(reserved.uploadUrl, { cookie: admin, headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    const tail = await api(reserved.uploadUrl, { cookie: admin, headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await tail.text()).toBe("789");
    const open = await api(reserved.uploadUrl, { cookie: admin, headers: { Range: "bytes=8-" } });
    expect(await open.text()).toBe("89");
    const bad = await api(reserved.uploadUrl, { cookie: admin, headers: { Range: "bytes=20-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */10");
    await bad.arrayBuffer();
    expect(parseRange("bytes=0-", 0)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeUndefined();
    expect(parseRange("bytes=5-2", 10)).toBeNull();
  });

  it("names match the stored type; a multi-file drop keeps its order", async () => {
    const { admin, showId, content } = await setup();
    const r = await uploadUrl(showId, admin, {
      table: "content",
      recordId: content,
      filename: "photo",
      contentType: "image/png",
      size: 10,
    });
    expect(((await r.json()) as UploadUrlResponse).attachmentId).toBeTruthy();
    // Reserved 1, 2, 3; the PUTs finish 3, 1, 2: positions follow the reserve order.
    const reserved: UploadUrlResponse[] = [];
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      const res = await uploadUrl(showId, admin, {
        table: "content",
        recordId: content,
        filename: name,
        contentType: "text/plain",
        size: 3,
      });
      reserved.push((await res.json()) as UploadUrlResponse);
    }
    for (const i of [2, 0, 1]) {
      const put = await api((reserved[i] as UploadUrlResponse).uploadUrl, {
        method: "PUT",
        cookie: admin,
        body: "abc",
      });
      expect(put.status).toBe(201);
      await put.arrayBuffer();
    }
    const png8 = await png(8, 6);
    const named = await uploadFile(
      showId,
      admin,
      { table: "content", recordId: content },
      { name: "still", type: "image/png", bytes: png8 },
    );
    const snap = await snapshot(showId, admin);
    const files = snap.tables.attachments
      .filter((f) => f.record_id === content)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((f) => f.filename);
    expect(files).toEqual(["one.txt", "two.txt", "three.txt", "still.png"]);
    await named.put.arrayBuffer();
  });
});
