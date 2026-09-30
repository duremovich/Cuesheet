import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../../../shared/attachments";
import { originalTooBig, textTooBig } from "./ImportPanel";
import { SAMPLE } from "./testData";

describe("import size checks (before any upload)", () => {
  it("refuses extracted text over the route's 8 MB limit", () => {
    expect(textTooBig(SAMPLE)).toBeNull();
    const big = {
      ...SAMPLE,
      blocks: Array.from({ length: 900 }, (_, i) => ({
        i,
        page: 1,
        kind: "other" as const,
        text: "x".repeat(10_000),
      })),
    };
    expect(textTooBig(big)).toMatch(/over 8 MB/);
  });
  it("flags an original over the attachment limit (the text still imports)", () => {
    expect(originalTooBig(new Blob(["abc"]))).toBe(false);
    expect(originalTooBig({ size: MAX_ATTACHMENT_BYTES + 1 } as Blob)).toBe(true);
  });
});
