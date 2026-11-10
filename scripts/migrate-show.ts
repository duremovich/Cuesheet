// Move one show from one Cuesheet instance to another, then verify the copy
// (docs/deploy.md, "Moving a show between instances"). Both instances must run the same
// Cuesheet version (the show schema is compared) and both logins must be instance admins.
//
//   node scripts/migrate-show.ts --from <url> --from-creds <file> --to <url> --to-creds <file>
//                                --show <id> [--overwrite] [--verify-only] [--concurrency 4]
//
// Creds files: `ADMIN_EMAIL=… / ADMIN_PASSWORD=… [/ URL=…]` lines (a .dev.vars) or JSON
// `{"email", "password", "url"?}`; a file's URL stands in for a missing --from / --to. Every
// request sends User-Agent `cuesheet-migrate/1.0` (Cloudflare blocks library defaults). Users referenced by the show map to the target account
// with the same email; anyone without one maps to the target login. Exit 0 = migrated (or
// already migrated) and verified; 1 = verify found differences; 2 = refused / failed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  canonicalJson,
  chunkRows,
  diffDigests,
  mapMemberships,
  parseCreds,
  R2_METADATA_HEADER,
  referencedIds,
  remapIds,
  SHA256_HEADER,
  type TableDigest,
  TRANSFER_USER_AGENT,
  type TransferCreds,
  type TransferFile,
  type TransferFinishResponse,
  type TransferManifest,
  type TransferRow,
  type TransferValue,
} from "../src/shared/show-transfer.ts";

/** Rows per POST, by JSON size (the target takes up to 16 MB). */
const ROWS_CHUNK_BYTES = 8 * 1024 * 1024;

class Failure extends Error {}

interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

class Instance {
  private cookies = new Map<string, string>();
  readonly base: string;
  readonly label: string;

  // No parameter properties: Node runs this file by stripping types only.
  constructor(label: string, url: string) {
    this.label = label;
    this.base = url.replace(/\/+$/, "");
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Origin", this.base);
    headers.set("User-Agent", TRANSFER_USER_AGENT);
    if (this.cookies.size) {
      headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // not JSON
      }
      throw new HttpError(
        res.status,
        `${this.label} ${init.method ?? "GET"} ${path}: ${res.status} ${msg}`,
      );
    }
    return JSON.parse(text) as T;
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  async login(creds: { email: string; password: string }): Promise<User> {
    await this.post("/api/auth/login", creds);
    const { user } = await this.json<{ user: User | null }>("/api/me");
    if (!user) throw new Failure(`${this.label}: signed in, but /api/me has no user`);
    if (!user.isAdmin) throw new Failure(`${this.label}: ${user.email} is not an instance admin`);
    return user;
  }
}

class HttpError extends Failure {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readCreds(file: string): TransferCreds {
  const creds = parseCreds(readFileSync(file, "utf8"));
  if (!creds) throw new Failure(`${file}: no ADMIN_EMAIL / ADMIN_PASSWORD`);
  return creds;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

const base = (showId: string) => `/api/admin/shows/${encodeURIComponent(showId)}/transfer`;

async function readTables(
  inst: Instance,
  showId: string,
  m: TransferManifest,
): Promise<Record<string, TransferRow[]>> {
  const out: Record<string, TransferRow[]> = {};
  for (const t of m.do.tables) {
    const rows: TransferRow[] = [];
    let after = 0;
    for (;;) {
      const page = await inst.json<{ rows: TransferRow[]; next: number | null }>(
        `${base(showId)}/rows?table=${encodeURIComponent(t.name)}&after=${after}`,
      );
      rows.push(...page.rows);
      if (page.next === null) break;
      after = page.next;
    }
    out[t.name] = rows;
  }
  return out;
}

function digest(rows: unknown[]): TableDigest {
  return { rows: rows.length, sha256: sha256(canonicalJson(rows)) };
}

const fmtBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

const mapJson = <T>(value: T, ids: ReadonlyMap<string, string>): T =>
  JSON.parse(remapIds(JSON.stringify(value), ids)) as T;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      "from-creds": { type: "string" },
      to: { type: "string" },
      "to-creds": { type: "string" },
      show: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "verify-only": { type: "boolean", default: false },
      concurrency: { type: "string", default: "4" },
    },
  });
  const usage =
    "usage: node scripts/migrate-show.ts [--from <url>] --from-creds <file> [--to <url>] --to-creds <file> --show <id> [--overwrite] [--verify-only]";
  const need = ["from-creds", "to-creds", "show"] as const;
  const missing = need.filter((k) => !values[k]);
  if (missing.length) {
    throw new Failure(`missing ${missing.map((k) => `--${k}`).join(", ")}\n${usage}`);
  }
  const srcCreds = readCreds(values["from-creds"] as string);
  const dstCreds = readCreds(values["to-creds"] as string);
  // An explicit --from / --to wins over the creds file's URL.
  const fromUrl = values.from ?? srcCreds.url;
  const toUrl = values.to ?? dstCreds.url;
  if (!fromUrl || !toUrl) {
    throw new Failure(
      `missing ${fromUrl ? "--to" : "--from"} (no URL= in its creds file)\n${usage}`,
    );
  }
  const showId = values.show as string;
  const concurrency = Math.max(1, Number(values.concurrency) || 4);
  const src = new Instance("source", fromUrl);
  const dst = new Instance("target", toUrl);
  if (src.base === dst.base) throw new Failure("--from and --to are the same instance");

  await src.login(srcCreds);
  const admin = await dst.login(dstCreds);
  console.log(`source ${src.base}  →  target ${dst.base} (as ${admin.email})`);

  const srcManifest = await src.json<TransferManifest>(base(showId));
  if (!srcManifest.d1.show) throw new Failure(`source: no show ${showId}`);
  console.log(`show "${srcManifest.d1.show.name}" (${showId})`);

  // ---- who is who ----
  const srcRows = await readTables(src, showId, srcManifest);
  const srcUsers = (await src.json<{ users: User[] }>("/api/admin/users")).users;
  const dstUsers = (await dst.json<{ users: User[] }>("/api/admin/users")).users;
  const dstByEmail = new Map(dstUsers.map((u) => [u.email.toLowerCase(), u]));
  const allText = JSON.stringify([srcRows, srcManifest.d1]);
  const used = referencedIds(
    allText,
    srcUsers.map((u) => u.id),
  );
  const ids = new Map<string, string>();
  console.log("users:");
  for (const u of srcUsers.filter((u) => used.has(u.id))) {
    const match = dstByEmail.get(u.email.toLowerCase());
    ids.set(u.id, (match ?? admin).id);
    console.log(
      match
        ? `  ${u.email} → ${match.email}`
        : `  ${u.email} → ${admin.email} (NO ACCOUNT ON TARGET: their notes, history, views and membership become ${admin.email}'s)`,
    );
  }
  const expectedD1 = mapJson(srcManifest.d1, ids);
  const expectedMembers = mapMemberships(expectedD1.memberships, new Map());

  if (!values["verify-only"]) {
    const dstManifest = await dst.json<TransferManifest>(base(showId));
    if (dstManifest.do.transfer?.state === "imported" && !values.overwrite) {
      console.log("target already has an import of this show; verifying it");
      const problems = await verify();
      if (problems === 0) {
        console.log("already migrated and verified; nothing to do");
        return 0;
      }
      throw new Failure("the existing import differs from the source; re-run with --overwrite");
    }
    await doImport(dstManifest);
  }
  return (await verify()) === 0 ? 0 : 1;

  async function doImport(dstManifest: TransferManifest) {
    if (dstManifest.do.transfer) {
      console.log(`target: a previous import (${dstManifest.do.transfer.state}) is there`);
    }
    try {
      await dst.post(`${base(showId)}/begin`, {
        migrations: srcManifest.do.migrations,
        overwrite: values.overwrite,
      });
    } catch (e) {
      if (
        e instanceof HttpError &&
        e.status === 409 &&
        /overwrite/.test(e.message) &&
        !values.overwrite
      ) {
        throw new Failure(`${e.message}\n(re-run with --overwrite to replace the previous import)`);
      }
      throw e;
    }
    const counts: Record<string, number> = {};
    for (const [table, rows] of Object.entries(srcRows)) {
      counts[table] = rows.length;
      for (const chunk of chunkRows(mapJson(rows, ids), ROWS_CHUNK_BYTES)) {
        await dst.post(`${base(showId)}/rows`, { table, rows: chunk });
      }
    }
    console.log(
      `rows staged: ${Object.values(counts).reduce((a, b) => a + b, 0)} in ${Object.keys(counts).length} tables`,
    );

    const { files } = await src.json<{ files: TransferFile[] }>(`${base(showId)}/files`);
    let done = 0;
    let bytes = 0;
    await pool(files, concurrency, async (f) => {
      const q = `?key=${encodeURIComponent(f.key)}`;
      const res = await src.request(`${base(showId)}/file${q}`);
      if (!res.ok) throw new Failure(`source: ${f.key}: ${res.status} ${await res.text()}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength !== f.size) {
        throw new Failure(`source: ${f.key}: got ${body.byteLength} bytes, listed ${f.size}`);
      }
      await dst.json(`${base(showId)}/file${q}`, {
        method: "PUT",
        body,
        headers: {
          "Content-Type": "application/octet-stream",
          [SHA256_HEADER]: sha256(body),
          [R2_METADATA_HEADER]: JSON.stringify({
            httpMetadata: f.httpMetadata,
            customMetadata: f.customMetadata,
          }),
        },
      });
      done++;
      bytes += f.size;
      if (done % 25 === 0 || done === files.length) {
        console.log(`files: ${done}/${files.length} (${fmtBytes(bytes)})`);
      }
    });
    if (files.length === 0) console.log("files: none");

    const fin = await dst.post<TransferFinishResponse>(`${base(showId)}/finish`, {
      counts,
      sequences: srcManifest.do.sequences,
      show: expectedD1.show,
      memberships: expectedMembers,
      shareLinks: expectedD1.shareLinks,
    });
    console.log(`imported at version ${fin.version}`);
    if (fin.skipped.memberships.length || fin.skipped.shareLinks.length) {
      console.log(`  skipped (user missing on target): ${JSON.stringify(fin.skipped)}`);
    }
  }

  /** Compare source and target; prints a report, returns the number of problems. */
  async function verify(): Promise<number> {
    console.log("verifying…");
    const problems: string[] = [];
    const s = await src.json<TransferManifest>(base(showId));
    const t = await dst.json<TransferManifest>(base(showId));
    if (s.do.migrations.join() !== t.do.migrations.join()) problems.push("show schema differs");
    if (!t.d1.show) problems.push("target: no show row in D1 (import not finished)");
    if (t.do.transfer?.state !== "imported") {
      problems.push(`target: import marker is ${t.do.transfer?.state ?? "missing"}`);
    }

    // Durable Object tables.
    const sRows = await readTables(src, showId, s);
    const tRows = await readTables(dst, showId, t);
    const sDigest: Record<string, TableDigest> = {};
    const tDigest: Record<string, TableDigest> = {};
    for (const [k, rows] of Object.entries(sRows)) sDigest[k] = digest(mapJson(rows, ids));
    for (const [k, rows] of Object.entries(tRows)) tDigest[k] = digest(rows);
    problems.push(...diffDigests(sDigest, tDigest));
    if (s.do.version !== t.do.version) problems.push(`version ${s.do.version} vs ${t.do.version}`);
    if (canonicalJson(s.do.sequences) !== canonicalJson(t.do.sequences)) {
      problems.push(
        `sqlite_sequence ${JSON.stringify(s.do.sequences)} vs ${JSON.stringify(t.do.sequences)}`,
      );
    }

    // D1.
    const d1 = mapJson(s.d1, ids);
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    if (!same(d1.show, t.d1.show)) problems.push("D1 show row differs");
    if (!same(mapMemberships(d1.memberships, new Map()), t.d1.memberships)) {
      problems.push("D1 memberships differ");
    }
    if (!same(d1.shareLinks, t.d1.shareLinks)) problems.push("D1 share links differ");

    // R2.
    const sFiles = (await src.json<{ files: TransferFile[] }>(`${base(showId)}/files`)).files;
    const tFiles = (await dst.json<{ files: TransferFile[] }>(`${base(showId)}/files`)).files;
    const tByKey = new Map(tFiles.map((f) => [f.key, f]));
    for (const f of tFiles) {
      if (!sFiles.some((x) => x.key === f.key)) problems.push(`file only on target: ${f.key}`);
    }
    let fileBytes = 0;
    let hashed = 0;
    await pool(sFiles, concurrency, async (f) => {
      const other = tByKey.get(f.key);
      if (!other) {
        problems.push(`file missing on target: ${f.key}`);
        return;
      }
      if (other.size !== f.size) problems.push(`file size differs: ${f.key}`);
      if (
        !same(other.httpMetadata, f.httpMetadata) ||
        !same(other.customMetadata, f.customMetadata)
      ) {
        problems.push(`file metadata differs: ${f.key}`);
      }
      const q = `${base(showId)}/file-hash?key=${encodeURIComponent(f.key)}`;
      const [a, b] = await Promise.all([
        src.json<{ sha256: string }>(q),
        dst.json<{ sha256: string }>(q),
      ]);
      if (a.sha256 !== b.sha256) problems.push(`file content differs: ${f.key}`);
      fileBytes += f.size;
      hashed++;
    });

    // Through the app: the snapshot each admin gets (shared views only: personal views
    // are per user, and mapped users merge).
    let snapshotNote = "";
    const [sSnap, tSnap] = await Promise.all([
      src.request(`/api/shows/${showId}/snapshot`),
      dst.request(`/api/shows/${showId}/snapshot`),
    ]);
    if (sSnap.ok && tSnap.ok) {
      const strip = (text: string) => {
        const o = JSON.parse(text) as { tables: { views: { owner_user_id: TransferValue }[] } };
        o.tables.views = o.tables.views.filter((v) => v.owner_user_id === null);
        return canonicalJson(o);
      };
      if (strip(remapIds(await sSnap.text(), ids)) !== strip(await tSnap.text())) {
        problems.push("app snapshot differs");
      }
      snapshotNote = "app snapshot matches";
    } else {
      snapshotNote = `app snapshot not compared (source ${sSnap.status}, target ${tSnap.status}: the login isn't a member)`;
    }

    // Report.
    const width = Math.max(...Object.keys(sDigest).map((k) => k.length));
    for (const name of Object.keys(sDigest).sort()) {
      const ok = tDigest[name] && tDigest[name].sha256 === sDigest[name]?.sha256;
      console.log(
        `  ${name.padEnd(width)}  ${String(sDigest[name]?.rows).padStart(6)} rows  ${ok ? "ok" : "DIFFERS"}`,
      );
    }
    console.log(
      `  D1: show row, ${t.d1.memberships.length} memberships, ${t.d1.shareLinks.length} share links`,
    );
    console.log(
      `  files: ${hashed}/${sFiles.length} hashed (${fmtBytes(fileBytes)}), sha256 compared on both sides`,
    );
    console.log(`  ${snapshotNote}`);
    if (problems.length) {
      console.log(`VERIFY FAILED (${problems.length}):`);
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      console.log("VERIFY OK: the target matches the source");
    }
    return problems.length;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Failure ? `error: ${e.message}` : e);
    process.exit(2);
  },
);
