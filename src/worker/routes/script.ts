// The script (R20; decisions 0004, 0007). Text is extracted in the browser and posted here
// as a ScriptText; it is stored gzipped in R2 (never in the DO's SQLite) and versions,
// anchors and stats go through the op engine like everything else:
//
//   POST /shows/:id/script/versions               import a version (+ re-anchor from the
//                                                 current one) → {versionId, results, stats}
//   GET  /shows/:id/script/versions/:vid/text     the version's ScriptText (JSON)
//   POST /shows/:id/script/versions/:vid/reanchor re-run re-anchoring from another version
//
// Re-anchoring runs here, in the Worker (./script-anchor is pure), so the DO only applies
// the resulting batch. Anchors are otherwise edited through normal ops (/mutate).
// Registered in shows.ts (they need its `requireMembership`). See CLAUDE.md "Script".
import type { Context } from "hono";
import { isValidId, newId } from "../../shared/ids";
import type { AnyOp } from "../../shared/ops";
import {
  type AnchorStats,
  buildPageMap,
  type CreateScriptVersionResponse,
  type ReanchorResponse,
  type ReanchorResult,
  type ScriptText,
  sanitizeScriptText,
  scriptTextKey,
} from "../../shared/script";
import { type AnchorInput, anchorStats, reanchor } from "../../shared/script-anchor";
import type { CueAnchorRow, ScriptVersionRow } from "../../shared/tables";
import { releaseStorage, reserveStorage } from "./files";
import type { ShowEnv } from "./shows";
import { jsonBody, readJsonObjectLimited } from "./util";

type C = Context<ShowEnv>;

/** Largest import body (the extracted text as JSON). */
export const MAX_SCRIPT_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_LABEL_LENGTH = 100;

const stub = (c: C) => c.env.SHOW.get(c.env.SHOW.idFromName(c.var.show.id));
const canEdit = (c: C) => c.var.role === "owner" || c.var.role === "editor";

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A version's text from R2, or null when missing. */
export async function loadScriptText(env: Env, key: string): Promise<ScriptText | null> {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as ScriptText;
}

/** An anchor row as engine input (a missing anchor has no position: block -1). */
function anchorInput(a: Omit<CueAnchorRow, "custom">): AnchorInput {
  return {
    cueId: a.cue_id,
    anchor: {
      block: a.block ?? -1,
      offset: a.offset ?? 0,
      length: a.length ?? 0,
      quote: a.quote ?? "",
      prefix: a.prefix ?? "",
      suffix: a.suffix ?? "",
    },
  };
}

/** The fields of a cue_anchors row for a re-anchoring result. */
function anchorFields(r: ReanchorResult): Record<string, unknown> {
  const a = r.to;
  return {
    block: a ? a.block : null,
    offset: a ? a.offset : null,
    length: a ? a.length : null,
    // A missing anchor keeps the old quote and context: the resolve screen shows them.
    quote: (a ?? r.from).quote,
    prefix: (a ?? r.from).prefix,
    suffix: (a ?? r.from).suffix,
    state: r.state,
    confidence: r.confidence,
  };
}

async function reanchorFrom(
  c: C,
  base: Omit<ScriptVersionRow, "custom">,
  newText: ScriptText,
): Promise<ReanchorResult[] | Response> {
  if (!base.text_key) return c.json({ error: "The base version has no text" }, 409);
  const oldText = await loadScriptText(c.env, base.text_key);
  if (!oldText) return c.json({ error: "The base version's text is missing" }, 409);
  const anchors = await stub(c).anchorsOf(base.id);
  return reanchor(oldText, newText, anchors.map(anchorInput));
}

export async function createVersion(c: C): Promise<Response> {
  if (!canEdit(c)) return c.json({ error: "Only editors can import a script" }, 403);
  const body = await readJsonObjectLimited(c, MAX_SCRIPT_BODY_BYTES);
  if (body === "too-large") {
    return c.json({ error: `The script is over ${MAX_SCRIPT_BODY_BYTES / 1024 / 1024} MB` }, 413);
  }
  if (!body) return c.json({ error: "Expected a JSON object" }, 400);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return c.json({ error: `label must be 1–${MAX_LABEL_LENGTH} characters` }, 400);
  }
  const versionId = body.versionId === undefined ? newId() : body.versionId;
  if (!isValidId(versionId)) return c.json({ error: "versionId must be an id" }, 400);
  const parsed = sanitizeScriptText(body.text);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const text = parsed.text;

  const info = await stub(c).scriptInfo();
  if (info.versions.some((v) => v.id === versionId)) {
    return c.json({ error: "That version already exists" }, 409);
  }
  const baseId =
    typeof body.baseVersionId === "string" ? body.baseVersionId : info.script?.current_version_id;
  const base = baseId ? info.versions.find((v) => v.id === baseId) : undefined;
  if (typeof body.baseVersionId === "string" && !base) {
    return c.json({ error: "baseVersionId is not a version of this script" }, 400);
  }

  let results: ReanchorResult[] = [];
  if (base) {
    const r = await reanchorFrom(c, base, text);
    if (r instanceof Response) return r;
    results = r;
  }
  const stats = anchorStats(results);

  const showId = c.var.show.id;
  const key = scriptTextKey(showId, versionId);
  const bytes = await gzip(JSON.stringify(text));
  if (!(await reserveStorage(c.env, showId, bytes.byteLength))) {
    return c.json({ error: "This show's storage is full" }, 413);
  }
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType: "application/gzip" },
  });

  const scriptId = info.script?.id ?? newId();
  const ops: AnyOp[] = [];
  if (!info.script) {
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : label;
    ops.push({
      op: "create",
      table: "scripts",
      id: scriptId,
      fields: { title: title.slice(0, 200) },
    });
  }
  ops.push(
    {
      op: "create",
      table: "script_versions",
      id: versionId,
      fields: {
        script_id: scriptId,
        label,
        source: text.source,
        confidence: text.confidence,
        text_key: key,
        text_bytes: bytes.byteLength,
        block_count: text.blocks.length,
        page_count: text.pages.length,
        page_map: buildPageMap(text),
        stats: base ? stats : {},
      },
    },
    // The new version is current at once (the resolve screen works on it); Cue.page follows
    // from its anchors, created next.
    { op: "update", table: "scripts", id: scriptId, fields: { current_version_id: versionId } },
    ...results.map(
      (r): AnyOp => ({
        op: "create",
        table: "cue_anchors",
        id: newId(),
        fields: { cue_id: r.cueId, script_version_id: versionId, ...anchorFields(r) },
      }),
    ),
  );
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 64) : null;
  const res = await stub(c).mutateScript(
    { userId: c.var.user.id, role: c.var.role, clientId: clientId || null },
    ops,
  );
  if (!res.ok) {
    await c.env.FILES.delete(key).catch(() => undefined);
    await releaseStorage(c.env, showId, bytes.byteLength);
    return c.json({ error: res.error }, res.status);
  }
  // Anchors of cues deleted meanwhile were dropped by the DO: report what was applied.
  const created = new Set(
    res.ops.flatMap((op) =>
      op.op === "create" && op.table === "cue_anchors" ? [op.fields.cue_id as string] : [],
    ),
  );
  const applied = results.filter((r) => created.has(r.cueId));
  return jsonBody<CreateScriptVersionResponse>(
    c,
    {
      scriptId,
      versionId,
      baseVersionId: base?.id ?? null,
      results: applied,
      stats: anchorStats(applied),
    },
    201,
  );
}

export async function versionText(c: C): Promise<Response> {
  const vid = c.req.param("vid") ?? "";
  const { versions } = await stub(c).scriptInfo();
  const version = isValidId(vid) ? versions.find((v) => v.id === vid) : undefined;
  if (!version?.text_key) return c.json({ error: "Script version not found" }, 404);
  const obj = await c.env.FILES.get(version.text_key, { onlyIf: c.req.raw.headers });
  if (!obj) return c.json({ error: "The version's text is missing" }, 404);
  const headers = new Headers({
    "Content-Type": "application/json",
    // A version's text never changes.
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: obj.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  return new Response(obj.body.pipeThrough(new DecompressionStream("gzip")), { headers });
}

export async function reanchorVersion(c: C): Promise<Response> {
  if (!canEdit(c)) return c.json({ error: "Only editors can re-anchor" }, 403);
  const vid = c.req.param("vid") ?? "";
  const body = await readJsonObjectLimited(c);
  const baseId = body && body !== "too-large" ? body.baseVersionId : undefined;
  if (typeof baseId !== "string") return c.json({ error: "baseVersionId is required" }, 400);
  if (baseId === vid) return c.json({ error: "Pick a different version to re-anchor from" }, 400);
  const info = await stub(c).scriptInfo();
  const target = info.versions.find((v) => v.id === vid);
  const base = info.versions.find((v) => v.id === baseId);
  if (!target) return c.json({ error: "Script version not found" }, 404);
  if (!base) return c.json({ error: "baseVersionId is not a version of this script" }, 400);
  const text = target.text_key ? await loadScriptText(c.env, target.text_key) : null;
  if (!text) return c.json({ error: "The version's text is missing" }, 409);
  const r = await reanchorFrom(c, base, text);
  if (r instanceof Response) return r;

  // Anchors placed by hand on the target stay; others are replaced (updated in place).
  const existing = new Map((await stub(c).anchorsOf(vid)).map((a) => [a.cue_id, a]));
  const results = r.filter((res) => existing.get(res.cueId)?.state !== "manual");
  const ops: AnyOp[] = results.map((res): AnyOp => {
    const had = existing.get(res.cueId);
    return had
      ? { op: "update", table: "cue_anchors", id: had.id, fields: anchorFields(res) }
      : {
          op: "create",
          table: "cue_anchors",
          id: newId(),
          fields: { cue_id: res.cueId, script_version_id: vid, ...anchorFields(res) },
        };
  });
  const stats: AnchorStats = anchorStats(results);
  ops.push({ op: "update", table: "script_versions", id: vid, fields: { stats } });
  const res = await stub(c).mutateScript(
    { userId: c.var.user.id, role: c.var.role, clientId: null },
    ops,
  );
  if (!res.ok) return c.json({ error: res.error }, res.status);
  return jsonBody<ReanchorResponse>(c, { versionId: vid, baseVersionId: baseId, results, stats });
}
