// Attachments (R13, S4): what may be uploaded, where it lives in R2, and the URLs that serve
// it. Used by the Worker (validation, keys) and the web client (pre-checks, URLs).
// Pipeline: CLAUDE.md "Attachments".

/** Largest single file. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Total attachment bytes per show (`shows.storage_bytes` in D1; thumbnails not counted). */
export const SHOW_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
/** Longest side of a generated thumbnail, px. */
export const THUMB_MAX = 320;
/** Longest filename kept (the rest is cut, keeping the extension). */
export const MAX_FILENAME = 120;

export type AttachmentKind = "image" | "pdf" | "video" | "text";

/** Allowed content types → kind. Images get thumbnails; the rest don't. */
const TYPES: Record<string, AttachmentKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "video/mp4": "video",
  "video/quicktime": "video",
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
};

/** Extension → content type, for files the browser gives no (or a generic) type. */
const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
};

const HEIC = /^image\/hei[cf](-sequence)?$/;

function extension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/**
 * The content type a file is stored and served as, or an error for the user. The declared
 * type wins when it's allowed; else the extension decides (browsers send "" for some).
 */
export function checkAttachmentType(
  contentType: string,
  filename: string,
): { contentType: string; kind: AttachmentKind } | { error: string } {
  const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = extension(filename);
  if (HEIC.test(declared) || ext === "heic" || ext === "heif") {
    return { error: "HEIC photos aren't supported yet: export them as JPEG or PNG" };
  }
  const kind = TYPES[declared];
  if (kind) return { contentType: declared, kind };
  const byExt = BY_EXTENSION[ext];
  if (byExt && (declared === "" || declared === "application/octet-stream")) {
    return { contentType: byExt, kind: TYPES[byExt] as AttachmentKind };
  }
  return {
    error: "That file type isn't supported (images, PDF, MP4/MOV video and text files are)",
  };
}

export function attachmentKind(contentType: string): AttachmentKind | null {
  return TYPES[contentType] ?? null;
}

export function isImageType(contentType: string): boolean {
  return TYPES[contentType] === "image";
}

/** A filename safe to use as an R2 key segment and in Content-Disposition. */
export function cleanFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  let n = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  if (!n || n === "." || n === "..") n = "file";
  if (n.length > MAX_FILENAME) {
    const ext = extension(n);
    const keep = ext && ext.length < 10 ? `.${ext}` : "";
    n = n.slice(0, MAX_FILENAME - keep.length) + keep;
  }
  return n;
}

/** R2 key of the file: `shows/<showId>/<attachmentId>/<filename>`. */
export function attachmentKey(showId: string, id: string, filename: string): string {
  return `shows/${showId}/${id}/${cleanFilename(filename)}`;
}

/** R2 key of an image's generated thumbnail (next to the file). */
export function thumbnailKey(showId: string, id: string): string {
  return `shows/${showId}/${id}/__thumb`;
}

export function attachmentUrl(showId: string, id: string, opts: { download?: boolean } = {}) {
  const base = `/api/shows/${encodeURIComponent(showId)}/attachments/${encodeURIComponent(id)}`;
  return opts.download ? `${base}?download=1` : base;
}

export function thumbnailUrl(showId: string, id: string): string {
  return `${attachmentUrl(showId, id)}/thumb`;
}

/** "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Width and height from an image file's first bytes (PNG, JPEG, GIF, WebP), or null. Used
 * by the Worker to record the real size of an upload without decoding it.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u16le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u32be = (i: number) => (u16be(i) * 65536 + u16be(i + 2)) >>> 0;
  const u24le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { width: u32be(16), height: u32be(20) };
  }
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = u16be(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}
