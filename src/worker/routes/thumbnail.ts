// Image thumbnails in the Worker with Photon (Rust → WASM, `@cf-wasm/photon`, which ships a
// workerd build). Decoding needs width × height × 4 bytes of WASM memory, so images above
// MAX_PIXELS aren't thumbnailed (a Worker has 128 MB); clients fall back to the original.
import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { imageSize, THUMB_MAX } from "../../shared/attachments";

/** 16 megapixels ≈ 64 MB decoded. */
export const MAX_PIXELS = 16_000_000;

export function thumbnailSize(width: number, height: number, max = THUMB_MAX) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A JPEG (for JPEG sources) or PNG (others, keeping transparency) at most THUMB_MAX px on
 * its longest side, or null when the image is too large or can't be decoded.
 */
export function makeThumbnail(
  bytes: Uint8Array,
  contentType: string,
): { bytes: Uint8Array; contentType: string } | null {
  const size = imageSize(bytes);
  if (!size || size.width * size.height > MAX_PIXELS) return null;
  let img: PhotonImage | null = null;
  let small: PhotonImage | null = null;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const t = thumbnailSize(img.get_width(), img.get_height());
    small = resize(img, t.width, t.height, SamplingFilter.Triangle);
    return contentType === "image/jpeg"
      ? { bytes: small.get_bytes_jpeg(82), contentType: "image/jpeg" }
      : { bytes: small.get_bytes(), contentType: "image/png" };
  } catch (e) {
    console.error("thumbnail failed", e);
    return null;
  } finally {
    small?.free();
    img?.free();
  }
}
