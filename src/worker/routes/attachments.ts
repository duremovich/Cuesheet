// Attachment bytes (R13, S4). Rows go through the op engine (history, broadcast); the files
// go through here, into and out of R2 (`env.FILES`):
//
//   POST /shows/:id/attachments/upload-url  reserve (role, type, size, storage checks)
//   PUT  /shows/:id/attachments/:aid        stream the body into R2, then create the row
//   GET  /shows/:id/attachments/:aid        the file (?download=1: as a download)
//   GET  /shows/:id/attachments/:aid/thumb  an image's thumbnail, made on first request
//   GET  /shows/:id/storage                 bytes used / limit
//
// Real R2 presigned URLs need API credentials we don't have locally, so the "upload URL" is
// our own PUT route, which streams the body straight into R2. Registered in shows.ts (they
// need its `requireMembership`). See CLAUDE.md "Attachments".
import type { Context } from "hono";
import type { StorageResponse, UploadUrlRequest, UploadUrlResponse } from "../../shared/api";
import {
  attachmentKey,
  attachmentUrl,
  checkAttachmentType,
  cleanFilename,
  imageSize,
  isImageType,
  MAX_ATTACHMENT_BYTES,
  SHOW_STORAGE_LIMIT_BYTES,
  THUMB_MAX,
  thumbnailKey,
} from "../../shared/attachments";
import { isValidId, newId } from "../../shared/ids";
import type { ResolvedCreate } from "../../shared/ops";
import { isAttachmentField } from "../../shared/tables";
import { releaseStorage, reserveStorage, storageUsed } from "./files";
import type { ShowEnv } from "./shows";
import { makeThumbnail } from "./thumbnail";
import { jsonBody, readJsonObject } from "./util";

type C = Context<ShowEnv>;

const stub = (c: C) => c.env.SHOW.get(c.env.SHOW.idFromName(c.var.show.id));
const tooBig = `Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
const full = `This show's storage is full (${SHOW_STORAGE_LIMIT_BYTES / 1024 ** 3} GB)`;

/**
 * Who may attach to a record: editors and the owner anything; commenters only their own
 * notes; viewers nothing. Returns an error response or null. (The op engine checks again.)
 */
async function checkCanAttach(c: C, table: string, recordId: string): Promise<Response | null> {
  const role = c.var.role;
  if (role === "viewer") return c.json({ error: "Viewers can't attach files" }, 403);
  const creator = await stub(c).recordCreator(table, recordId);
  if (creator === undefined) return c.json({ error: "That record doesn't exist" }, 404);
  if (role === "commenter" && !(table === "notes" && creator === c.var.user.id)) {
    return c.json({ error: "Commenters can only attach files to their own notes" }, 403);
  }
  return null;
}

export async function uploadUrl(c: C): Promise<Response> {
  const body = (await readJsonObject(c)) as Partial<UploadUrlRequest> | null;
  const table = typeof body?.table === "string" ? body.table : "";
  const recordId = typeof body?.recordId === "string" ? body.recordId : "";
  const field = typeof body?.field === "string" ? body.field : "attachments";
  const filename = typeof body?.filename === "string" ? cleanFilename(body.filename) : "";
  const size = body?.size;
  if (!isAttachmentField(table, field)) {
    return c.json({ error: `${table}.${field} is not an attachment field` }, 400);
  }
  if (!isValidId(recordId)) return c.json({ error: "recordId must be an id" }, 400);
  if (!filename) return c.json({ error: "filename is required" }, 400);
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    return c.json({ error: "size must be a byte count" }, 400);
  }
  const denied = await checkCanAttach(c, table, recordId);
  if (denied) return denied;
  if (size > MAX_ATTACHMENT_BYTES) return c.json({ error: tooBig }, 413);
  const type = checkAttachmentType(
    typeof body?.contentType === "string" ? body.contentType : "",
    filename,
  );
  if ("error" in type) return c.json({ error: type.error }, 415);
  if ((await storageUsed(c.env, c.var.show.id)) + size > SHOW_STORAGE_LIMIT_BYTES) {
    return c.json({ error: full }, 413);
  }
  const attachmentId = newId();
  await stub(c).reserveUpload(attachmentId, {
    userId: c.var.user.id,
    table,
    recordId,
    field,
    filename,
    contentType: type.contentType,
    size,
  });
  return c.json({
    attachmentId,
    uploadUrl: attachmentUrl(c.var.show.id, attachmentId),
    contentType: type.contentType,
  } satisfies UploadUrlResponse);
}

export async function upload(c: C): Promise<Response> {
  const id = c.req.param("aid") ?? "";
  const showId = c.var.show.id;
  const len = Number(c.req.header("Content-Length") ?? "");
  if (!c.req.header("Content-Length") || !Number.isInteger(len) || len < 0) {
    return c.json({ error: "Content-Length is required" }, 411);
  }
  if (len > MAX_ATTACHMENT_BYTES) return c.json({ error: tooBig }, 413);
  const pending = isValidId(id) ? await stub(c).takeUpload(id, c.var.user.id) : null;
  if (!pending) return c.json({ error: "Unknown or expired upload; ask for a new URL" }, 404);
  const denied = await checkCanAttach(c, pending.table, pending.recordId);
  if (denied) return denied;
  if (!(await reserveStorage(c.env, showId, len))) return c.json({ error: full }, 413);

  const key = attachmentKey(showId, id, pending.filename);
  const fail = async (status: 400 | 403 | 413 | 500, error: string) => {
    await c.env.FILES.delete(key).catch(() => undefined);
    await releaseStorage(c.env, showId, len);
    return c.json({ error }, status);
  };
  try {
    // A fixed-length stream: R2 needs the length, and a body longer or shorter than its
    // Content-Length fails the put instead of storing something else.
    const { readable, writable } = new FixedLengthStream(len);
    const pipe = (c.req.raw.body ?? new Blob([]).stream()).pipeTo(writable);
    await Promise.all([
      c.env.FILES.put(key, readable, {
        httpMetadata: {
          contentType: pending.contentType,
          cacheControl: "private, max-age=31536000, immutable",
        },
        customMetadata: { filename: pending.filename, showId },
      }),
      pipe,
    ]);
  } catch (e) {
    console.error("upload failed", e);
    return fail(400, "The upload didn't complete; try again");
  }

  let size: { width: number; height: number } | null = null;
  if (isImageType(pending.contentType)) {
    const head = await c.env.FILES.get(key, { range: { offset: 0, length: 64 * 1024 } });
    if (head) size = imageSize(new Uint8Array(await head.arrayBuffer()));
  }
  const res = await stub(c).mutate(
    { userId: c.var.user.id, role: c.var.role, clientId: null, upload: true },
    [
      {
        op: "create",
        table: "attachments",
        id,
        fields: {
          table: pending.table,
          record_id: pending.recordId,
          field: pending.field,
          filename: pending.filename,
          content_type: pending.contentType,
          size: len,
          r2_key: key,
          width: size?.width ?? null,
          height: size?.height ?? null,
        },
      },
    ],
  );
  if (!res.ok) return fail(res.status, res.error);
  const created = res.ops.find((op): op is ResolvedCreate => op.op === "create" && op.id === id);
  return jsonBody(c, { attachment: created ? { id, ...created.fields } : { id } }, 201);
}

/** Headers for serving a stored file: never sniffed or run as a page. */
function fileHeaders(object: R2Object, filename: string, download: boolean): Headers {
  const h = new Headers();
  object.writeHttpMetadata(h);
  h.set("ETag", object.httpEtag);
  h.set("Cache-Control", "private, max-age=31536000, immutable");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
  const safe = filename.replace(/["\\]/g, "_");
  h.set(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return h;
}

export async function download(c: C): Promise<Response> {
  const id = c.req.param("aid") ?? "";
  const row = isValidId(id) ? await stub(c).attachment(id) : null;
  if (!row) return c.json({ error: "Attachment not found" }, 404);
  const object = await c.env.FILES.get(row.r2_key, { onlyIf: c.req.raw.headers });
  if (!object) return c.json({ error: "File missing" }, 404);
  const headers = fileHeaders(object, row.filename, c.req.query("download") === "1");
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

/**
 * An image's thumbnail (≤ THUMB_MAX px on its longest side), generated with Photon (WASM)
 * on first request and stored next to the file. 404 for non-images and images we can't
 * decode or that are too large to decode in a Worker; clients then show the original.
 */
export async function thumbnail(c: C): Promise<Response> {
  const id = c.req.param("aid") ?? "";
  const row = isValidId(id) ? await stub(c).attachment(id) : null;
  if (!row) return c.json({ error: "Attachment not found" }, 404);
  if (!isImageType(row.content_type)) return c.json({ error: "No thumbnail" }, 404);
  const key = thumbnailKey(c.var.show.id, id);
  let object: R2Object | R2ObjectBody | null = await c.env.FILES.get(key, {
    onlyIf: c.req.raw.headers,
  });
  if (!object) {
    const small =
      row.width !== null && row.height !== null && Math.max(row.width, row.height) <= THUMB_MAX;
    if (small) {
      // Already thumbnail-sized: serve the file itself.
      object = await c.env.FILES.get(row.r2_key, { onlyIf: c.req.raw.headers });
    } else {
      const original = await c.env.FILES.get(row.r2_key);
      if (!original) return c.json({ error: "File missing" }, 404);
      const made = makeThumbnail(new Uint8Array(await original.arrayBuffer()), row.content_type);
      if (!made) return c.json({ error: "No thumbnail" }, 404);
      await c.env.FILES.put(key, made.bytes, {
        httpMetadata: { contentType: made.contentType },
      });
      await stub(c).setThumbKey(id, key);
      object = await c.env.FILES.get(key);
    }
    if (!object) return c.json({ error: "No thumbnail" }, 404);
  }
  const headers = fileHeaders(object, `thumb-${row.filename}`, false);
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

export async function storage(c: C): Promise<Response> {
  return c.json({
    usedBytes: await storageUsed(c.env, c.var.show.id),
    limitBytes: SHOW_STORAGE_LIMIT_BYTES,
  } satisfies StorageResponse);
}
