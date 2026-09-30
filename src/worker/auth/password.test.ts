import { describe, expect, it } from "vitest";
import { DEFAULT_ITERATIONS, hashPassword, needsRehash, verifyPassword } from "./password";

// A low iteration count keeps most tests fast; the format and code path are the same.
const FAST = 1_000;

describe("password hashing (PBKDF2-SHA256)", () => {
  it("round-trips: the right password verifies, a wrong one does not", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    expect(stored).toMatch(/^pbkdf2\$1000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("uses a 16-byte random salt: the same password hashes differently each time", async () => {
    const a = await hashPassword("same password", FAST);
    const b = await hashPassword("same password", FAST);
    expect(a).not.toBe(b);
    expect(atob(a.split("$")[2] as string)).toHaveLength(16);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("defaults to 100,000 iterations (the hosted Workers PBKDF2 cap)", async () => {
    expect(DEFAULT_ITERATIONS).toBe(100_000);
    const stored = await hashPassword("pw-with-defaults");
    expect(stored.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("pw-with-defaults", stored)).toBe(true);
    expect(needsRehash(stored)).toBe(false);
  });

  it("verifies older parameters and flags them for rehash", async () => {
    const older = await hashPassword("rehash me later", 5_000);
    expect(await verifyPassword("rehash me later", older)).toBe(true);
    expect(needsRehash(older)).toBe(true);
    expect(needsRehash("scrypt$16384$8$1$AAAA$AAAA")).toBe(true);
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
      "scrypt$16384$8$1$AAAA$AAAA",
      "pbkdf2$x$AAAA$AAAA",
      "pbkdf2$0$AAAA$AAAA",
      "pbkdf2$999999999$AAAA$AAAA",
      "pbkdf2$1000$!!!$AAAA",
      "pbkdf2$1000$$",
      "pbkdf2$1000$AAAA",
    ]) {
      expect(await verifyPassword("anything", bad), bad).toBe(false);
    }
  });
});
