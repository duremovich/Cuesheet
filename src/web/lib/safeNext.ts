// Validate the post-login `?next=` destination so it can only point inside this app.

// Backslashes (browsers treat them as "/") and C0/DEL control characters (stripped by the
// URL parser, and they crash React Router's matcher). Built from char codes so the source
// contains no literal control characters.
const FORBIDDEN = new RegExp(
  `[\\\\${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

function hasForbidden(s: string): boolean {
  if (FORBIDDEN.test(s)) return true;
  try {
    return FORBIDDEN.test(decodeURIComponent(s)); // catches %5C, %09, %00 ...
  } catch {
    return true; // malformed percent-encoding
  }
}

/** A same-origin path (+ search + hash) to go to after login, or "/" if `next` is unsafe. */
export function safeNext(next: string | null | undefined, origin: string): string {
  if (!next?.startsWith("/") || next.startsWith("//") || hasForbidden(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin || !url.pathname.startsWith("/")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
