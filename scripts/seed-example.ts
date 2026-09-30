// pnpm seed:example — create a show "Some Like It Hot" on a running dev server and import
// the example Airtable CSVs into it. Signs in as ADMIN_EMAIL / ADMIN_PASSWORD from the
// environment or .dev.vars. Target server: SEED_URL (default http://localhost:5173).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = (process.env.SEED_URL ?? "http://localhost:5173").replace(/\/$/, "");
const SHOW_NAME = process.env.SEED_SHOW_NAME ?? "Some Like It Hot";
const FILES = [
  "Breakdown-Grid view.csv",
  "Personnel-Grid view.csv",
  "Content-Grid view.csv",
  "Cue List-Video Cue List View.csv",
  "Notes-NOTES.csv",
];

function devVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

async function call(pathname: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  // Same-origin, like the browser: the API's CSRF check wants an Origin on writes.
  headers.set("Origin", BASE);
  if (init.cookie) headers.set("Cookie", init.cookie);
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathname} → ${res.status} ${JSON.stringify(body)}`);
  }
  return { res, body };
}

async function main() {
  const vars = devVars();
  const email = process.env.ADMIN_EMAIL ?? vars.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD ?? vars.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Set ADMIN_EMAIL / ADMIN_PASSWORD (or .dev.vars)");

  const json = { "Content-Type": "application/json" };
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password }),
  });
  const cookie = (login.res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

  const created = await call("/api/shows", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: SHOW_NAME }),
    cookie,
  });
  const showId = (created.body?.show as { id: string } | undefined)?.id;
  if (!showId) throw new Error("Creating the show returned no id");

  const form = new FormData();
  for (const f of FILES) {
    const text = readFileSync(path.join("examples", f), "utf8");
    form.append("files", new Blob([text], { type: "text/csv" }), f);
  }
  const imported = await call(`/api/shows/${showId}/import/airtable`, {
    method: "POST",
    body: form,
    cookie,
  });
  const { created: counts, warnings } = imported.body as {
    created: Record<string, number>;
    warnings: string[];
  };
  console.log(`Created "${SHOW_NAME}": ${BASE}/shows/${showId}`);
  console.log("Imported:", counts);
  if (warnings.length) console.log(`${warnings.length} warnings:\n  ${warnings.join("\n  ")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  if (e instanceof TypeError) console.error(`Is the dev server running at ${BASE}? (pnpm dev)`);
  process.exit(1);
});
