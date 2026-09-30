import type { Context } from "hono";

/** Parse a JSON object body, or null if the body is missing / not an object. */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * JSON response without Hono's typed `c.json`, whose type-level JSON conversion recurses
 * forever on the recursive `Json` type used for custom field values.
 */
export function jsonBody<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  return c.body(JSON.stringify(data), status, { "Content-Type": "application/json" });
}

/** Largest request body accepted by the show data routes (mutate, import). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** True when the declared Content-Length is over `limit` (checked before reading). */
export function declaredTooLarge(c: Context, limit = MAX_BODY_BYTES): boolean {
  const len = Number(c.req.header("Content-Length") ?? "");
  return Number.isFinite(len) && len > limit;
}

/**
 * Parse a JSON object body of at most `limit` bytes, measured before JSON.parse.
 * `"too-large"` means answer 413; null means missing or not a JSON object.
 */
export async function readJsonObjectLimited(
  c: Context,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown> | null | "too-large"> {
  if (declaredTooLarge(c, limit)) return "too-large";
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > limit) return "too-large";
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(buf));
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
