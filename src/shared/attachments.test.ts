import { describe, expect, it } from "vitest";
import {
  attachmentKey,
  attachmentUrl,
  checkAttachmentType,
  cleanFilename,
  formatBytes,
  imageSize,
  MAX_DECODE_PIXELS,
  resizeTarget,
  thumbnailKey,
  thumbnailUrl,
} from "./attachments";

describe("attachments (shared)", () => {
  it("allows images, PDF, MP4/MOV and text; refuses HEIC and the rest", () => {
    expect(checkAttachmentType("image/png", "a.png")).toEqual({
      contentType: "image/png",
      kind: "image",
    });
    expect(checkAttachmentType("image/jpeg; charset=x", "a.jpg")).toMatchObject({
      contentType: "image/jpeg",
    });
    expect(checkAttachmentType("", "clip.MOV")).toEqual({
      contentType: "video/quicktime",
      kind: "video",
    });
    expect(checkAttachmentType("application/octet-stream", "doc.pdf")).toMatchObject({
      kind: "pdf",
    });
    expect(checkAttachmentType("text/plain", "notes.txt")).toMatchObject({ kind: "text" });
    expect(checkAttachmentType("image/heic", "IMG_1.HEIC")).toEqual({
      error: expect.stringMatching(/HEIC/),
    });
    expect(checkAttachmentType("", "IMG_1.heic")).toMatchObject({ error: expect.any(String) });
    expect(checkAttachmentType("image/svg+xml", "a.svg")).toMatchObject({
      error: expect.stringMatching(/isn't supported/),
    });
    expect(checkAttachmentType("text/html", "a.html")).toMatchObject({ error: expect.any(String) });
    // A declared type we don't allow isn't rescued by the extension.
    expect(checkAttachmentType("text/html", "a.png")).toMatchObject({ error: expect.any(String) });
  });

  it("keys and URLs", () => {
    expect(attachmentKey("s1", "a1", "Stage/left.png")).toBe("shows/s1/a1/Stage_left.png");
    expect(thumbnailKey("s1", "a1")).toBe("shows/s1/a1/__thumb");
    expect(attachmentUrl("s1", "a1")).toBe("/api/shows/s1/attachments/a1");
    expect(attachmentUrl("s1", "a1", { download: true })).toBe(
      "/api/shows/s1/attachments/a1?download=1",
    );
    expect(thumbnailUrl("s1", "a1")).toBe("/api/shows/s1/attachments/a1/thumb");
  });

  it("cleans file names", () => {
    expect(cleanFilename("  ../x\u0000y.png ")).toBe(".._x_y.png");
    expect(cleanFilename("..")).toBe("file");
    const long = cleanFilename(`${"a".repeat(300)}.jpeg`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GB");
  });

  it("reads image sizes from PNG, GIF, JPEG and WebP headers", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(imageSize(png)).toEqual({ width: 640, height: 480 });

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0xc8, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 300, height: 200 });

    // SOI, an APP0 segment, then SOF0 with height 100, width 250.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64,
      0x00, 0xfa, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 250, height: 100 });

    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
    // VP8X: canvas width-1 / height-1 as 24-bit little endian at 24 / 27.
    webp.set([0x3f, 0x01, 0x00, 0xef, 0x00, 0x00], 24);
    expect(imageSize(webp)).toEqual({ width: 320, height: 240 });

    expect(imageSize(new TextEncoder().encode("hello world, not an image"))).toBeNull();
  });

  it("scales photos over 16.7 MP down to fit 4096 px and MAX_DECODE_PIXELS", () => {
    expect(resizeTarget(4000, 3000)).toBeNull();
    expect(resizeTarget(4096, 4096)).toBeNull();
    expect(resizeTarget(8000, 6000)).toEqual({ width: 4096, height: 3072 });
    const pano = resizeTarget(20000, 1000);
    expect(pano).toEqual({ width: 4096, height: 204 });
    const square = resizeTarget(6000, 6000) as { width: number; height: number };
    expect(square.width * square.height).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
    expect(Math.max(square.width, square.height)).toBeLessThanOrEqual(4096);
  });
});
