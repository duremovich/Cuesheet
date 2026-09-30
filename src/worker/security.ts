// Security headers for everything the Worker serves (docs/deploy.md, "Security headers").
// Pages (the SPA shell) come from the ASSETS binding through the Worker (wrangler.jsonc
// `run_worker_first`), so they get a Content-Security-Policy that allows only our own
// origin: scripts from self plus the hashes of index.html's inline scripts (the theme
// picker), WASM compilation (pdf.js decoders), workers from self and blob: (the pdf.js
// worker), images/media from self, data: and blob: (attachment files are same-origin
// /api/shows/… routes; previews use object URLs), sockets to our own host.

const SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s);
}

/** `'sha256-…'` sources for every inline <script> in an HTML page. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (m[1]?.trim()) out.push(`'sha256-${await sha256Base64(m[1])}'`);
  }
  return out;
}

/** Where browsers send CSP violation reports (`POST /api/csp-report`, logged, 204). */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * `https`: sockets only over wss:// (production); plain http (local) allows ws:// only.
 */
export function contentSecurityPolicy(
  host: string,
  scriptHashes: readonly string[],
  https = true,
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(" ")}`.trim(),
    "worker-src 'self' blob:",
    // React style attributes and the print pages' @page rules.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${https ? "wss" : "ws"}://${host}`,
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp",
  ].join("; ");
}

/** Headers every response gets (API included). */
export function baseSecurityHeaders(headers: Headers, https: boolean): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  // An internal tool: nothing should be indexed.
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (https) headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

let cached: { html: string; host: string; csp: string } | null = null;

/**
 * Secrets that travel in URLs (share tokens) must not reach logs: `/s/<token>` and
 * `/api/share/<token>` become `[token]` in anything the Worker logs.
 */
export function redactTokens(text: string): string {
  return text.replace(/(\/s\/|\/api\/share\/)[A-Za-z0-9_%-]+/g, "$1[token]");
}

/** `console.error` with share tokens redacted from every string argument. */
export function logError(...args: unknown[]): void {
  console.error(
    ...args.map((a) =>
      typeof a === "string"
        ? redactTokens(a)
        : a instanceof Error
          ? redactTokens(`${a.name}: ${a.message}\n${a.stack ?? ""}`)
          : a,
    ),
  );
}

/**
 * Serve a page from the assets binding with security headers. HTML gets the CSP (built
 * from its inline scripts; cached per isolate) and frame protection; `csp: false` skips
 * the CSP (Vite's dev server injects inline scripts of its own). A 304 keeps the CSP the
 * browser stored with the page.
 */
export async function serveAsset(
  request: Request,
  assets: Fetcher,
  opts: { csp: boolean },
): Promise<Response> {
  const res = await assets.fetch(request);
  const url = new URL(request.url);
  const https = url.protocol === "https:";
  const html = (res.headers.get("Content-Type") ?? "").includes("text/html");
  if (!html || !opts.csp || res.status !== 200) {
    const out = new Response(res.body, res);
    baseSecurityHeaders(out.headers, https);
    if (html) out.headers.set("X-Frame-Options", "DENY");
    return out;
  }
  const text = await res.text();
  let csp = cached?.html === text && cached.host === url.host ? cached.csp : null;
  if (csp === null) {
    csp = contentSecurityPolicy(url.host, await inlineScriptHashes(text), https);
    cached = { html: text, host: url.host, csp };
  }
  const page = new Response(text, res);
  baseSecurityHeaders(page.headers, https);
  page.headers.set("X-Frame-Options", "DENY");
  page.headers.set("Content-Security-Policy", csp);
  page.headers.set("Reporting-Endpoints", `csp="${CSP_REPORT_PATH}"`);
  page.headers.delete("Content-Length");
  return page;
}
