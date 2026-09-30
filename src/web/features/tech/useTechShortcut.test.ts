import { describe, expect, it } from "vitest";
import { isTechKey, techUrl } from "./useTechShortcut";

const key = (o: Partial<Parameters<typeof isTechKey>[0]>) => ({
  code: "Period",
  metaKey: false,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  isComposing: false,
  ...o,
});

describe("tech mode shortcut", () => {
  it("is ⌘/Ctrl+Shift+. only", () => {
    expect(isTechKey(key({}))).toBe(true);
    expect(isTechKey(key({ ctrlKey: false, metaKey: true }))).toBe(true);
    // Plain letters (the old bare T) and near misses don't open it.
    expect(isTechKey(key({ code: "KeyT", ctrlKey: false, shiftKey: false }))).toBe(false);
    expect(isTechKey(key({ shiftKey: false }))).toBe(false);
    expect(isTechKey(key({ ctrlKey: false }))).toBe(false);
    expect(isTechKey(key({ altKey: true }))).toBe(false);
    expect(isTechKey(key({ isComposing: true }))).toBe(false);
  });

  it("carries the current cue", () => {
    expect(techUrl("s1", "c1")).toBe("/shows/s1/tech?cue=c1");
    expect(techUrl("s1", null)).toBe("/shows/s1/tech");
  });
});
