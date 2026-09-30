import { describe, expect, it } from "vitest";
import { safeNext } from "./safeNext";

const ORIGIN = "https://cuesheet.example";

describe("safeNext", () => {
  it("keeps same-app paths with search and hash", () => {
    expect(safeNext("/shows/abc", ORIGIN)).toBe("/shows/abc");
    expect(safeNext("/shows/abc?tab=notes#cue-12", ORIGIN)).toBe("/shows/abc?tab=notes#cue-12");
    expect(safeNext("/", ORIGIN)).toBe("/");
  });

  it("falls back to / when missing", () => {
    expect(safeNext(null, ORIGIN)).toBe("/");
    expect(safeNext(undefined, ORIGIN)).toBe("/");
    expect(safeNext("", ORIGIN)).toBe("/");
  });

  it("rejects other origins and protocol-relative URLs", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "///evil.example",
      "javascript:alert(1)",
      "shows/abc",
      "evil.example",
    ]) {
      expect(safeNext(bad, ORIGIN), bad).toBe("/");
    }
  });

  it("rejects backslashes and control characters, raw or percent-encoded", () => {
    for (const bad of [
      "/\\example.com",
      "/\\\\example.com",
      "/%5Cexample.com",
      "/%09/example.com",
      `/${String.fromCharCode(9)}/example.com`,
      `/shows/${String.fromCharCode(0)}x`,
      "/%00",
      "/%7F",
      "/%E0%A4%A", // malformed encoding
    ]) {
      expect(safeNext(bad, ORIGIN), JSON.stringify(bad)).toBe("/");
    }
  });
});
