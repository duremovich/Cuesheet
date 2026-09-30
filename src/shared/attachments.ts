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
  let n = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    // Bidi overrides/isolates would let "gpj.exe" display as "exe.jpg".
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
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

/** The EXIF Orientation (1–8) in a TIFF block (after "Exif\0\0"), or null. */
export function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49; // "II"; "MM" is big endian
  const u16 = (i: number) =>
    le ? (t[i] ?? 0) | ((t[i + 1] ?? 0) << 8) : ((t[i] ?? 0) << 8) | (t[i + 1] ?? 0);
  const u32 = (i: number) =>
    le ? (u16(i) | (u16(i + 2) << 16)) >>> 0 : ((u16(i) << 16) | u16(i + 2)) >>> 0;
  const ifd = u32(4);
  const count = u16(ifd);
  for (let e = 0; e < count; e++) {
    const at = ifd + 2 + e * 12;
    if (at + 12 > t.length) return null;
    if (u16(at) === 0x0112) {
      const v = u16(at + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/**
 * Width and height from an image file's first bytes (PNG, JPEG, GIF, WebP), or null. Used
 * by the Worker to record the real size of an upload without decoding it. For a JPEG with
 * an EXIF Orientation other than 1, `orientation` is set and the size is the upright one
 * (5–8 swap width and height), which is how the image is shown.
 */
export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number; orientation?: number } | null {
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
    let orientation = 1;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = u16be(i + 2);
      if (marker === 0xe1 && ascii(i + 4, 6) === "Exif\u0000\u0000") {
        orientation = exifOrientation(b.subarray(i + 10, i + 2 + len)) ?? orientation;
      }
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const w = u16be(i + 7);
        const h = u16be(i + 5);
        // EXIF 5–8 turn the picture a quarter: the displayed size is swapped.
        const turned = orientation >= 5 && orientation <= 8;
        return {
          width: turned ? h : w,
          height: turned ? w : h,
          ...(orientation !== 1 ? { orientation } : {}),
        };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Largest image the Worker decodes for a thumbnail (width × height ≈ 64 MB of RGBA); the
 * client scales bigger photos down before uploading them (`resizeTarget`), so every
 * uploaded image gets a thumbnail.
 */
export const MAX_DECODE_PIXELS = 4096 * 4096;
/** Longest side of an image the client scaled down before upload. */
export const RESIZE_LONGEST = 4096;

/**
 * The size to scale an image to before upload, or null to upload it as it is (it's within
 * MAX_DECODE_PIXELS). The result fits both RESIZE_LONGEST and MAX_DECODE_PIXELS.
 */
export function resizeTarget(
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0 || width * height <= MAX_DECODE_PIXELS) return null;
  const scale = Math.min(
    RESIZE_LONGEST / Math.max(width, height),
    Math.sqrt(MAX_DECODE_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** The extensions each stored type may have (the first is the one added when missing). */
const EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "video/mp4": ["mp4", "m4v"],
  "video/quicktime": ["mov"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "text/markdown": ["md"],
};

/**
 * The filename with an extension matching the type it's stored and served as ("photo" →
 * "photo.jpg", "notes.exe" as text/plain → "notes.exe.txt"), so a download opens as what
 * it is.
 */
export function withExtension(filename: string, contentType: string): string {
  const exts = EXTENSIONS[contentType];
  if (!exts) return filename;
  if (exts.includes(extension(filename))) return filename;
  return cleanFilename(`${filename}.${exts[0]}`);
}
