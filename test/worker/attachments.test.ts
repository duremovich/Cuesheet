// Attachments (R13, S4): upload-url → PUT into R2 → row through the op engine; download,
// thumbnails (Photon), roles, types, sizes, the per-show storage cap, and cleanup of R2
// objects when rows (or their records) are deleted.
import { env } from "cloudflare:workers";
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

/** Cleanup runs in waitUntil: poll for it. */
async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
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
    expect(thumb.status, await thumb.clone().text()).toBe(200);
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

    // PUT: over the size limit, missing length, unknown or someone else's reservation.
    const ok = (await (
      await uploadUrl(showId, admin, { ...base, filename: "a.txt", contentType: "text/plain" })
    ).json()) as UploadUrlResponse;
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

  it("deleting a file or its record deletes the R2 objects and frees the storage", async () => {
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

    const del = await mutate(showId, admin, [{ op: "delete", table: "attachments", id: rowA.id }]);
    expect(del.status).toBe(200);
    await del.arrayBuffer();
    await eventually(async () => (await env.FILES.head(rowA.r2_key)) === null, "file deleted");
    await eventually(
      async () => (await env.FILES.head(thumbnailKey(showId, rowA.id))) === null,
      "thumb deleted",
    );
    await eventually(async () => (await used(showId)) === rowB.size, "storage freed");

    // Deleting the content cascades to its attachments (explicit delete ops first).
    const res = await mutate(showId, admin, [{ op: "delete", table: "content", id: content }]);
    const body = (await res.json()) as MutateResponse;
    expect(body.ops.map((o) => [o.op, o.table])).toEqual([
      ["delete", "attachments"],
      ["delete", "content"],
    ]);
    await eventually(async () => (await env.FILES.head(rowB.r2_key)) === null, "file deleted");
    await eventually(async () => (await used(showId)) === 0, "storage freed");
    const gone = await api(b.reserved.uploadUrl, { cookie: admin });
    expect(gone.status).toBe(404);
    await gone.arrayBuffer();
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
});
