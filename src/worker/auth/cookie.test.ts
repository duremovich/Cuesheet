import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  parseCookies,
  readSessionToken,
  SESSION_COOKIE,
  serializeSessionCookie,
} from "./cookie";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

describe("parseCookies", () => {
  it("parses multiple cookies with whitespace", () => {
    const m = parseCookies("a=1;  b=two ; c=%20x");
    expect(Object.fromEntries(m)).toEqual({ a: "1", b: "two", c: " x" });
  });

  it("handles empty, missing and malformed input", () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
    expect(Object.fromEntries(parseCookies("novalue; =x; ok=1; bad=%E0%A4%A"))).toEqual({
      ok: "1",
    });
  });

  it("keeps the first occurrence and unquotes values", () => {
    expect(parseCookies('a="quoted"; a=second').get("a")).toBe("quoted");
  });

  it("keeps '=' inside values", () => {
    expect(parseCookies("x=a=b==").get("x")).toBe("a=b==");
  });
});

describe("readSessionToken", () => {
  it("finds the session cookie among others", () => {
    expect(readSessionToken(`theme=dark; ${SESSION_COOKIE}=${TOKEN}; other=1`)).toBe(TOKEN);
  });

  it("returns null when absent or not token-shaped", () => {
    expect(readSessionToken("theme=dark")).toBeNull();
    expect(readSessionToken(`${SESSION_COOKIE}=`)).toBeNull();
    expect(readSessionToken(`${SESSION_COOKIE}=short`)).toBeNull();
    expect(readSessionToken(`${SESSION_COOKIE}=has spaces and; more`)).toBeNull();
    expect(readSessionToken(`${SESSION_COOKIE}=${"x".repeat(200)}`)).toBeNull();
  });
});

describe("serializeSessionCookie", () => {
  it("sets the security attributes", () => {
    const c = serializeSessionCookie(TOKEN, { secure: true });
    expect(c.startsWith(`${SESSION_COOKIE}=${TOKEN};`)).toBe(true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Secure");
    expect(c).toMatch(/Max-Age=2592000(;|$)/);
  });

  it("omits Secure for http (local dev)", () => {
    expect(serializeSessionCookie(TOKEN, { secure: false })).not.toContain("Secure");
  });

  it("round-trips through the parser", () => {
    const header = serializeSessionCookie(TOKEN, { secure: false }).split(";")[0];
    expect(readSessionToken(header)).toBe(TOKEN);
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie({ secure: false })).toMatch(
      new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`),
    );
  });
});
