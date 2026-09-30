import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("defaults to dark", () => {
    expect(resolveTheme(null, false)).toBe("dark");
  });
  it("follows a system light preference when the user hasn't chosen", () => {
    expect(resolveTheme(null, true)).toBe("light");
  });
  it("a stored choice beats the system preference", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
  it("ignores garbage in storage", () => {
    expect(resolveTheme("purple", false)).toBe("dark");
  });
});
