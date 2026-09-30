import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("defaults to dark when the user hasn't chosen", () => {
    expect(resolveTheme(null)).toBe("dark");
  });
  it("uses the stored choice", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
  it("ignores garbage in storage", () => {
    expect(resolveTheme("purple")).toBe("dark");
  });
});
