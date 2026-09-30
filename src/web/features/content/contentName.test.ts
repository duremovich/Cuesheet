import { describe, expect, it } from "vitest";
import { prefixedContentName, scenePrefix } from "./contentName";

describe("prefixedContentName", () => {
  const existing = [
    "105-001-VAMP",
    "105-002-CheetahChase_V01",
    "103-004-CANTHAVEME",
    null,
    "notes",
  ];

  it("prefixes the scene number and the next free number in that scene", () => {
    expect(prefixedContentName("NEWLOOK", "105", existing)).toBe("105-003-NEWLOOK");
    expect(prefixedContentName("  spotlight ", "103", existing)).toBe("103-005-spotlight");
    expect(prefixedContentName("FIRST", "207", existing)).toBe("207-001-FIRST");
  });

  it("pads short scene numbers", () => {
    expect(scenePrefix("99")).toBe("099");
    expect(prefixedContentName("PRESHOW LOOP", "99", ["099-004-X"])).toBe("099-005-PRESHOW LOOP");
  });

  it("keeps names that already have the prefix, or when there's no usable scene", () => {
    expect(prefixedContentName("105-009-MINE", "105", existing)).toBe("105-009-MINE");
    expect(prefixedContentName("LOOSE", null, existing)).toBe("LOOSE");
    expect(prefixedContentName("LOOSE", "Preshow", existing)).toBe("LOOSE");
    expect(prefixedContentName("LOOSE", "1001", existing)).toBe("LOOSE");
  });
});
