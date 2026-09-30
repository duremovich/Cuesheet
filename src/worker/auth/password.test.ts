import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// Cheap parameters keep the suite fast; the format and code path are the same.
const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe("password hashing", () => {
  it("round-trips: the right password verifies, a wrong one does not", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts: the same password hashes differently each time", async () => {
    const a = await hashPassword("same password", FAST);
    const b = await hashPassword("same password", FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("uses the default (production) parameters when none are given", async () => {
    const stored = await hashPassword("pw-with-defaults");
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("pw-with-defaults", stored)).toBe(true);
  });

  it("normalises Unicode so visually identical passwords match", async () => {
    const precomposed = `caf${String.fromCodePoint(0xe9)}`; // é as one code point
    const decomposed = `cafe${String.fromCodePoint(0x301)}`; // e + combining acute accent
    expect(precomposed).not.toBe(decomposed);
    const stored = await hashPassword(precomposed, FAST);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    for (const bad of [
      "",
      "plain",
      "bcrypt$1$2$3$4$5",
      "scrypt$x$8$1$AAAA$AAAA",
      "scrypt$1024$8$1",
    ]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});
