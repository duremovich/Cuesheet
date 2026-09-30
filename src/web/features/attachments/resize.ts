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

export async function shrinkLargeImage(file: File): Promise<PreparedFile> {
  if (!RESIZABLE.has(file.type) || typeof createImageBitmap !== "function") return { file };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
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
