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
