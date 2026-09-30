import { describe, expect, it } from "vitest";
import { isAnimatedWebp, shrinkLargeImage } from "./resize";

function webp(chunk: string, flags = 0, extra = ""): Uint8Array {
  const head = `RIFF\0\0\0\0WEBP${chunk}\0\0\0\0`;
  const bytes = new Uint8Array(head.length + 4 + extra.length);
  bytes.set(new TextEncoder().encode(head));
  bytes[20] = flags;
  bytes.set(new TextEncoder().encode(extra), head.length + 4);
  return bytes;
}

describe("client resize", () => {
  it("recognises animated WebP (VP8X animation flag or an ANIM chunk)", () => {
    expect(isAnimatedWebp(webp("VP8X", 0x02))).toBe(true);
    expect(isAnimatedWebp(webp("VP8X", 0x10, "ANIM"))).toBe(true);
    expect(isAnimatedWebp(webp("VP8X", 0x10))).toBe(false);
    expect(isAnimatedWebp(webp("VP8 "))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("leaves GIFs and non-images alone (uploaded as they are)", async () => {
    const gif = new File([new Uint8Array(10)], "a.gif", { type: "image/gif" });
    expect((await shrinkLargeImage(gif)).file).toBe(gif);
    const pdf = new File([new Uint8Array(10)], "a.pdf", { type: "application/pdf" });
    expect((await shrinkLargeImage(pdf)).file).toBe(pdf);
  });
});
