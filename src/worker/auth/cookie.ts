// Session cookie: parse and serialize. Pure functions so they can be unit-tested in Node.

export const SESSION_COOKIE = "cs_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Parse a Cookie header into a map. Malformed pairs are skipped; first occurrence wins. */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      // Invalid percent-encoding: ignore this cookie rather than failing the request.
    }
  }
  return out;
}

/** The session token from a Cookie header, or null if absent or obviously malformed. */
export function readSessionToken(header: string | null | undefined): string | null {
  const token = parseCookies(header).get(SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  return token;
}

export interface CookieOptions {
  /** Add `Secure`. True for https origins; false for http://localhost in dev. */
  secure: boolean;
  /** Lifetime in ms; 0 clears the cookie. */
  maxAgeMs?: number;
}

export function serializeSessionCookie(token: string, opts: CookieOptions): string {
  const maxAge = Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(opts: Pick<CookieOptions, "secure">): string {
  return serializeSessionCookie("", { secure: opts.secure, maxAgeMs: 0 });
}
