// Photos too big for the Worker to thumbnail (over 16.7 MP, e.g. 48 MP phone shots) are
// scaled down in the browser before upload (longest side ≤ 4096 px, `resizeTarget`), so
// every uploaded image gets a thumbnail. The original size goes along as `originalSize`
// (kept in the attachment's `custom.original_size`).
import { resizeTarget } from "../../../shared/attachments";

export interface PreparedFile {
  file: Blob;
  originalSize?: { width: number; height: number };
}

/** Types the browser can re-encode faithfully (GIF would lose its animation). */
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** An animated WebP (VP8X with the animation flag, or an ANIM chunk): uploaded as is. */
export function isAnimatedWebp(head: Uint8Array): boolean {
  const ascii = (i: number, n: number) => String.fromCharCode(...head.subarray(i, i + n));
  if (head.length < 21 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return false;
  if (ascii(12, 4) === "VP8X" && ((head[20] ?? 0) & 0x02) !== 0) return true;
  for (let i = 12; i + 4 <= head.length; i++) if (ascii(i, 4) === "ANIM") return true;
  return false;
}

export async function shrinkLargeImage(file: File): Promise<PreparedFile> {
  if (!RESIZABLE.has(file.type) || typeof createImageBitmap !== "function") return { file };
  if (file.type === "image/webp") {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (isAnimatedWebp(head)) return { file };
  }
  let bitmap: ImageBitmap;
  try {
    // Drawn upright (EXIF orientation applied); the re-encoded file carries no EXIF, so
    // its pixels are the way the photo is meant to be seen, and so are its dimensions.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { file }; // not decodable here: the server decides
  }
  const original = { width: bitmap.width, height: bitmap.height };
  const target = resizeTarget(original.width, original.height);
  if (!target) {
    bitmap.close();
    return { file };
  }
  try {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await canvas.convertToBlob({ type: file.type, quality: 0.9 });
    return {
      file: new File([blob], file.name, { type: file.type, lastModified: file.lastModified }),
      originalSize: original,
    };
  } catch {
    return { file };
  } finally {
    bitmap.close();
  }
}
