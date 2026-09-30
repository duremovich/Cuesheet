// The script (R20): importing versions (text gzipped in R2, re-anchoring, stats), the text
// route, anchor ops (validation, derived pages, Cue.page), cascades, roles, and the
// version's original file through the attachments pipeline.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UploadUrlResponse } from "../../src/shared/api";
import { DOCX_TYPE } from "../../src/shared/attachments";
import { newId } from "../../src/shared/ids";
import type { MutateResponse, Op, SnapshotResponse } from "../../src/shared/ops";
import {
  type CreateScriptVersionResponse,
  type ReanchorResponse,
  type ScriptText,
  scriptTextKey,
} from "../../src/shared/script";
import { makeAnchor } from "../../src/shared/script-anchor";
import { api, createShow, loginAdmin, newUser, post } from "./helpers";

/** A small script: `n` lines, `perPage` per page, labels "1", "2", … unless given. */
function scriptText(lines: string[], perPage = 4, labels: Record<number, string> = {}): ScriptText {
  const blocks = lines.map((text, i) => ({
    i,
    page: Math.floor(i / perPage) + 1,
    kind: "dialogue" as const,
    text,
  }));
  const pages = [...new Set(blocks.map((b) => b.page))].map((page) => ({
    page,
    label: labels[page] ?? String(page),
  }));
  return { blocks, pages, source: "txt", confidence: 1 };
}

const LINES = [
  "ACT ONE",
  "Scene 1. A Chicago speakeasy, 1929.",
  "JOE",
  "Sweet Sue needs a sax and a bass player by Friday.",
  "JERRY",
  "We could always go to Florida with the girls.",
  "The lights snap out. A police whistle.",
  "SUGAR",
  "I always get the fuzzy end of the lollipop.",
  "OSGOOD",
  "Nobody's perfect!",
  "Blackout.",
];

async function setup() {
  const admin = await loginAdmin();
  const show = await createShow(admin, `Script ${Date.now()}`);
  return { admin, showId: show.id };
}

function mutate(showId: string, cookie: string, ops: Op[]) {
  return post(`/api/shows/${showId}/mutate`, { clientId: "t", ops }, cookie);
}

async function snapshot(showId: string, cookie: string) {
  return (await (
    await api(`/api/shows/${showId}/snapshot`, { cookie })
  ).json()) as SnapshotResponse;
}

async function importVersion(
  showId: string,
  cookie: string,
  body: { label: string; text: ScriptText; versionId?: string; baseVersionId?: string },
) {
  return post(`/api/shows/${showId}/script/versions`, body, cookie);
}

async function addMember(showId: string, admin: string, role: "editor" | "commenter" | "viewer") {
  const user = await newUser(admin, role);
  const res = await post(`/api/shows/${showId}/members`, { email: user.email, role }, admin);
  expect(res.status).toBe(201);
  return user;
}

async function createCues(showId: string, cookie: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => newId());
  const res = await mutate(
    showId,
    cookie,
    ids.map((id, i) => ({ op: "create", table: "cues", id, fields: { number: String(i + 1) } })),
  );
  expect(res.status).toBe(200);
  return ids;
}

function anchorOp(cueId: string, versionId: string, text: ScriptText, block: number): Op {
  const a = makeAnchor(text, block, 0, (text.blocks[block] as { text: string }).text.length);
  return {
    op: "create",
    table: "cue_anchors",
    id: newId(),
    fields: {
      cue_id: cueId,
      script_version_id: versionId,
      block: a.block,
      offset: a.offset,
      length: a.length,
      quote: a.quote,
      prefix: a.prefix,
      suffix: a.suffix,
      state: "manual",
      confidence: 1,
    },
  };
}

describe("script versions", () => {
  it("imports a first version: script + version rows, text in R2, served back as JSON", async () => {
    const { admin, showId } = await setup();
    const text = scriptText(LINES, 4, { 2: "14a" });
    const versionId = newId();
    const res = await importVersion(showId, admin, { label: "Draft 9/12", text, versionId });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as CreateScriptVersionResponse;
    expect(body).toMatchObject({ versionId, baseVersionId: null, results: [] });

    const snap = await snapshot(showId, admin);
    expect(snap.tables.scripts).toHaveLength(1);
    expect(snap.tables.scripts[0]).toMatchObject({
      id: body.scriptId,
      title: "Draft 9/12",
      current_version_id: versionId,
    });
    const v = snap.tables.script_versions[0];
    expect(v).toMatchObject({
      id: versionId,
      script_id: body.scriptId,
      label: "Draft 9/12",
      source: "txt",
      confidence: 1,
      block_count: 12,
      page_count: 3,
      text_key: scriptTextKey(showId, versionId),
      attachment_id: null,
      page_map: [
        { startBlock: 0, page: 1, label: "1" },
        { startBlock: 4, page: 2, label: "14a" },
        { startBlock: 8, page: 3, label: "3" },
      ],
    });
    expect(v?.imported_at).toBeGreaterThan(0);
    // Stored gzipped in R2, counted in the show's storage.
    const obj = await env.FILES.get(scriptTextKey(showId, versionId));
    const raw = new Uint8Array((await obj?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
    expect(v?.text_bytes).toBe(raw.length);
    const used = await env.DB.prepare("SELECT storage_bytes AS n FROM shows WHERE id = ?")
      .bind(showId)
      .first<{ n: number }>();
    expect(used?.n).toBe(raw.length);

    const got = await api(`/api/shows/${showId}/script/versions/${versionId}/text`, {
      cookie: admin,
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/json");
    expect(await got.json()).toEqual(text);
    const etag = got.headers.get("ETag") ?? "";
    const again = await api(`/api/shows/${showId}/script/versions/${versionId}/text`, {
      cookie: admin,
      headers: { "If-None-Match": etag },
    });
    expect(again.status).toBe(304);
    const unknown = await api(`/api/shows/${showId}/script/versions/${newId()}/text`, {
      cookie: admin,
    });
    expect(unknown.status).toBe(404);
  });

  it("validates the request", async () => {
    const { admin, showId } = await setup();
    const text = scriptText(LINES);
    expect((await importVersion(showId, admin, { label: "", text })).status).toBe(400);
    expect(
      (await importVersion(showId, admin, { label: "x", text: { ...text, blocks: [] } })).status,
    ).toBe(400);
    expect(
      (await importVersion(showId, admin, { label: "x", text, versionId: "nope" })).status,
    ).toBe(400);
    expect(
      (await importVersion(showId, admin, { label: "x", text, baseVersionId: newId() })).status,
    ).toBe(400);
    const id = newId();
    expect((await importVersion(showId, admin, { label: "x", text, versionId: id })).status).toBe(
      201,
    );
    expect((await importVersion(showId, admin, { label: "y", text, versionId: id })).status).toBe(
      409,
    );
  });

  it("re-anchors every cue on a new version, reports states, updates Cue.page", async () => {
    const { admin, showId } = await setup();
    const v1Text = scriptText(LINES);
    const v1 = newId();
    expect(
      (await importVersion(showId, admin, { label: "v1", text: v1Text, versionId: v1 })).status,
    ).toBe(201);
    const [qSue, qFlorida, qLolly, qPerfect] = await createCues(showId, admin, 4);
    const placed = await mutate(showId, admin, [
      anchorOp(qSue as string, v1, v1Text, 3),
      anchorOp(qFlorida as string, v1, v1Text, 5),
      anchorOp(qLolly as string, v1, v1Text, 8),
      anchorOp(qPerfect as string, v1, v1Text, 10),
    ]);
    expect(placed.status, await placed.clone().text()).toBe(200);
    let snap = await snapshot(showId, admin);
    const pageOf = (id: string) => snap.tables.cues.find((c) => c.id === id)?.page;
    expect(pageOf(qSue as string)).toBe("1");
    expect(pageOf(qLolly as string)).toBe("3");

    // v2: two lines inserted at the top (everything shifts down), Florida's line edited,
    // "Nobody's perfect!" cut.
    const v2Lines = [
      "PROLOGUE",
      "A new opening line of stage business.",
      ...LINES.slice(0, 5),
      "We could always go down to Florida with the girls.",
      ...LINES.slice(6, 9),
      "OSGOOD",
      "Blackout.",
    ];
    const v2Text = scriptText(v2Lines, 4, { 3: "3a" });
    const res = await importVersion(showId, admin, { label: "v2", text: v2Text });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as CreateScriptVersionResponse;
    expect(body.baseVersionId).toBe(v1);
    const byCue = new Map(body.results.map((r) => [r.cueId, r]));
    expect(byCue.get(qSue as string)).toMatchObject({ state: "moved", to: { block: 5 } });
    expect(byCue.get(qFlorida as string)).toMatchObject({ state: "changed", to: { block: 7 } });
    expect(byCue.get(qLolly as string)).toMatchObject({ state: "moved", to: { block: 10 } });
    expect(byCue.get(qPerfect as string)).toMatchObject({ state: "missing", to: null });
    expect(body.stats).toEqual({ matched: 0, moved: 2, changed: 1, missing: 1, manual: 0 });

    snap = await snapshot(showId, admin);
    expect(snap.tables.scripts[0]?.current_version_id).toBe(body.versionId);
    const v2Row = snap.tables.script_versions.find((v) => v.id === body.versionId);
    expect(v2Row?.stats).toEqual(body.stats);
    const anchors = snap.tables.cue_anchors.filter((a) => a.script_version_id === body.versionId);
    expect(anchors).toHaveLength(4);
    const missing = anchors.find((a) => a.cue_id === qPerfect);
    expect(missing).toMatchObject({
      state: "missing",
      block: null,
      page: null,
      quote: "Nobody's perfect!",
    });
    expect(anchors.find((a) => a.cue_id === qLolly)).toMatchObject({ block: 10, page: 3 });
    // Cue.page from the new current version ("3a"); the cut cue keeps its old page.
    expect(pageOf(qLolly as string)).toBe("3a");
    expect(pageOf(qSue as string)).toBe("2");
    expect(pageOf(qPerfect as string)).toBe("3");
    // Old anchors stay with v1.
    expect(snap.tables.cue_anchors.filter((a) => a.script_version_id === v1)).toHaveLength(4);

    // Switching the current version back re-derives Cue.page from v1's anchors.
    const back = await mutate(showId, admin, [
      { op: "update", table: "scripts", id: body.scriptId, fields: { current_version_id: v1 } },
    ]);
    expect(back.status).toBe(200);
    snap = await snapshot(showId, admin);
    expect(pageOf(qLolly as string)).toBe("3");
    expect(pageOf(qSue as string)).toBe("1");
  });

  it("re-runs re-anchoring from a chosen version, keeping manual anchors", async () => {
    const { admin, showId } = await setup();
    const v1Text = scriptText(LINES);
    const v1 = newId();
    await importVersion(showId, admin, { label: "v1", text: v1Text, versionId: v1 });
    const [a, b] = await createCues(showId, admin, 2);
    await mutate(showId, admin, [
      anchorOp(a as string, v1, v1Text, 3),
      anchorOp(b as string, v1, v1Text, 8),
    ]);
    const v2Text = scriptText(["New first line.", ...LINES]);
    const created = (await (
      await importVersion(showId, admin, { label: "v2", text: v2Text })
    ).json()) as CreateScriptVersionResponse;
    const v2 = created.versionId;
    // The user re-places cue a by hand on v2.
    let snap = await snapshot(showId, admin);
    const aOnV2 = snap.tables.cue_anchors.find((x) => x.cue_id === a && x.script_version_id === v2);
    const manual = await mutate(showId, admin, [
      {
        op: "update",
        table: "cue_anchors",
        id: aOnV2?.id as string,
        fields: { block: 1, offset: 0, length: 5, state: "manual" },
      },
    ]);
    expect(manual.status).toBe(200);

    const res = await post(
      `/api/shows/${showId}/script/versions/${v2}/reanchor`,
      { baseVersionId: v1 },
      admin,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as ReanchorResponse;
    expect(body.results.map((r) => r.cueId)).toEqual([b]);
    expect(body.stats.matched + body.stats.moved).toBe(1);
    snap = await snapshot(showId, admin);
    const onV2 = snap.tables.cue_anchors.filter((x) => x.script_version_id === v2);
    expect(onV2).toHaveLength(2);
    expect(onV2.find((x) => x.cue_id === a)).toMatchObject({ block: 1, state: "manual" });
    expect(snap.tables.script_versions.find((v) => v.id === v2)?.stats).toEqual(body.stats);

    expect(
      (
        await post(
          `/api/shows/${showId}/script/versions/${v2}/reanchor`,
          { baseVersionId: v2 },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(`/api/shows/${showId}/script/versions/${v2}/reanchor`, {}, admin)).status,
    ).toBe(400);
  });
});

describe("anchor ops", () => {
  it("validates anchors and derives their page", async () => {
    const { admin, showId } = await setup();
    const text = scriptText(LINES, 4, { 2: "14a" });
    const vid = newId();
    await importVersion(showId, admin, { label: "v1", text, versionId: vid });
    const [cue] = await createCues(showId, admin, 1);
    const fields = { cue_id: cue, script_version_id: vid };
    const bad = async (f: Record<string, unknown>) => {
      const res = await mutate(showId, admin, [
        { op: "create", table: "cue_anchors", id: newId(), fields: { ...fields, ...f } },
      ]);
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    expect(await bad({ block: 12 })).toMatchObject({ status: 400, error: /less than 12/ });
    expect(await bad({ block: 1, offset: -1 })).toMatchObject({ status: 400 });
    expect(await bad({ block: 1, length: 1.5 })).toMatchObject({ status: 400 });
    expect(await bad({ block: null, state: "matched" })).toMatchObject({ status: 400 });
    expect(await bad({ block: 1, state: "wobbly" })).toMatchObject({ status: 400 });
    expect(await bad({ block: 1, confidence: 2 })).toMatchObject({ status: 400 });

    const id = newId();
    const res = await mutate(showId, admin, [
      // A page sent by the client is replaced by the derived one.
      { op: "create", table: "cue_anchors", id, fields: { ...fields, block: 5, page: 99 } },
    ]);
    expect(res.status).toBe(200);
    const created = ((await res.json()) as MutateResponse).ops.find(
      (o) => o.op === "create" && o.table === "cue_anchors",
    );
    expect(created).toMatchObject({
      fields: { block: 5, offset: 0, length: 0, page: 2, state: "manual" },
    });
    let snap = await snapshot(showId, admin);
    expect(snap.tables.cues.find((c) => c.id === cue)?.page).toBe("14a");
    expect(await bad({ block: 2 })).toMatchObject({ status: 400, error: /already has an anchor/ });

    // Moving the anchor moves Cue.page; marking it missing clears its position.
    await mutate(showId, admin, [{ op: "update", table: "cue_anchors", id, fields: { block: 9 } }]);
    snap = await snapshot(showId, admin);
    expect(snap.tables.cue_anchors.find((a) => a.id === id)?.page).toBe(3);
    expect(snap.tables.cues.find((c) => c.id === cue)?.page).toBe("3");
    const cleared = await mutate(showId, admin, [
      { op: "update", table: "cue_anchors", id, fields: { block: null, state: "missing" } },
    ]);
    expect(cleared.status).toBe(200);
    snap = await snapshot(showId, admin);
    expect(snap.tables.cue_anchors.find((a) => a.id === id)).toMatchObject({
      block: null,
      offset: null,
      length: null,
      page: null,
    });
    // cue_id / script_version_id can't change.
    const moveCue = await mutate(showId, admin, [
      { op: "update", table: "cue_anchors", id, fields: { cue_id: newId() } },
    ]);
    expect(moveCue.status).toBe(400);
  });

  it("server-set version fields, one script per show, clients can't create versions", async () => {
    const { admin, showId } = await setup();
    const vid = newId();
    const created = (await (
      await importVersion(showId, admin, { label: "v1", text: scriptText(LINES), versionId: vid })
    ).json()) as CreateScriptVersionResponse;
    const tryOps = async (ops: Op[]) => (await mutate(showId, admin, ops)).status;
    expect(
      await tryOps([
        {
          op: "create",
          table: "script_versions",
          id: newId(),
          fields: { script_id: created.scriptId },
        },
      ]),
    ).toBe(403);
    expect(
      await tryOps([
        { op: "update", table: "script_versions", id: vid, fields: { block_count: 999 } },
      ]),
    ).toBe(400);
    expect(
      await tryOps([
        { op: "update", table: "script_versions", id: vid, fields: { label: "Rehearsal draft" } },
      ]),
    ).toBe(200);
    expect(
      await tryOps([{ op: "create", table: "scripts", id: newId(), fields: { title: "Another" } }]),
    ).toBe(400);
    expect(
      await tryOps([
        {
          op: "update",
          table: "scripts",
          id: created.scriptId,
          fields: { current_version_id: newId() },
        },
      ]),
    ).toBe(400);
  });

  it("roles: only editors import and place; everyone reads the text", async () => {
    const { admin, showId } = await setup();
    const text = scriptText(LINES);
    const vid = newId();
    await importVersion(showId, admin, { label: "v1", text, versionId: vid });
    const [cue] = await createCues(showId, admin, 1);
    const viewer = await addMember(showId, admin, "viewer");
    const commenter = await addMember(showId, admin, "commenter");
    const editor = await addMember(showId, admin, "editor");
    for (const u of [viewer, commenter]) {
      expect((await importVersion(showId, u.cookie, { label: "x", text })).status).toBe(403);
      expect((await mutate(showId, u.cookie, [anchorOp(cue as string, vid, text, 1)])).status).toBe(
        403,
      );
      expect(
        (
          await post(
            `/api/shows/${showId}/script/versions/${vid}/reanchor`,
            { baseVersionId: vid },
            u.cookie,
          )
        ).status,
      ).toBe(403);
      const read = await api(`/api/shows/${showId}/script/versions/${vid}/text`, {
        cookie: u.cookie,
      });
      expect(read.status).toBe(200);
    }
    expect(
      (await mutate(showId, editor.cookie, [anchorOp(cue as string, vid, text, 1)])).status,
    ).toBe(200);
    const outsider = await newUser(admin, "outsider");
    const denied = await api(`/api/shows/${showId}/script/versions/${vid}/text`, {
      cookie: outsider.cookie,
    });
    expect(denied.status).toBe(404);
  });
});

describe("cascades", () => {
  it("deleting a cue deletes its anchors; deleting the current version promotes the newest other", async () => {
    const { admin, showId } = await setup();
    const t1 = scriptText(LINES);
    const v1 = newId();
    await importVersion(showId, admin, { label: "v1", text: t1, versionId: v1 });
    const [a, b] = await createCues(showId, admin, 2);
    await mutate(showId, admin, [
      anchorOp(a as string, v1, t1, 3),
      anchorOp(b as string, v1, t1, 8),
    ]);
    const v2 = newId();
    await importVersion(showId, admin, {
      label: "v2",
      text: scriptText(LINES, 3),
      versionId: v2,
    });
    let snap = await snapshot(showId, admin);
    expect(snap.tables.cue_anchors).toHaveLength(4);
    expect(snap.tables.cues.find((c) => c.id === b)?.page).toBe("3"); // block 8, 3 per page

    const delCue = await mutate(showId, admin, [{ op: "delete", table: "cues", id: a as string }]);
    const delOps = ((await delCue.json()) as MutateResponse).ops;
    expect(delOps.filter((o) => o.op === "delete" && o.table === "cue_anchors")).toHaveLength(2);
    snap = await snapshot(showId, admin);
    expect(snap.tables.cue_anchors.map((x) => x.cue_id)).toEqual([b, b]);

    const delVersion = await mutate(showId, admin, [
      { op: "delete", table: "script_versions", id: v2 },
    ]);
    expect(delVersion.status).toBe(200);
    snap = await snapshot(showId, admin);
    expect(snap.tables.script_versions.map((v) => v.id)).toEqual([v1]);
    expect(snap.tables.scripts[0]?.current_version_id).toBe(v1);
    expect(snap.tables.cue_anchors.map((x) => x.script_version_id)).toEqual([v1]);
    expect(snap.tables.cues.find((c) => c.id === b)?.page).toBe("3"); // v1: 4 per page → page 3
    // Its text waits a day in R2, then goes (and its bytes come back).
    expect(await env.FILES.get(scriptTextKey(showId, v2))).not.toBeNull();
    const stub = env.SHOW.get(env.SHOW.idFromName(showId));
    const usedBytes = async () =>
      (
        await env.DB.prepare("SELECT storage_bytes AS n FROM shows WHERE id = ?")
          .bind(showId)
          .first<{ n: number }>()
      )?.n ?? -1;
    const v1Bytes = snap.tables.script_versions[0]?.text_bytes as number;
    expect(await usedBytes()).toBeGreaterThan(v1Bytes);
    expect(await stub.purgeDeletedFiles(Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    expect(await env.FILES.get(scriptTextKey(showId, v2))).toBeNull();
    expect(await usedBytes()).toBe(v1Bytes); // only v1's text is left

    // Deleting the script deletes everything under it.
    const del = await mutate(showId, admin, [
      { op: "delete", table: "scripts", id: snap.tables.scripts[0]?.id as string },
    ]);
    expect(del.status).toBe(200);
    snap = await snapshot(showId, admin);
    expect(snap.tables.scripts).toHaveLength(0);
    expect(snap.tables.script_versions).toHaveLength(0);
    expect(snap.tables.cue_anchors).toHaveLength(0);
  });

  it("the original file uploads to the version (DOCX allowed) and is linked by attachment_id", async () => {
    const { admin, showId } = await setup();
    const vid = newId();
    await importVersion(showId, admin, { label: "v1", text: scriptText(LINES), versionId: vid });
    const bytes = new TextEncoder().encode("PK fake docx bytes");
    const r = await post(
      `/api/shows/${showId}/attachments/upload-url`,
      {
        table: "script_versions",
        recordId: vid,
        field: "source_file",
        filename: "Some Like It Hot v1.docx",
        contentType: DOCX_TYPE,
        size: bytes.length,
      },
      admin,
    );
    expect(r.status, await r.clone().text()).toBe(200);
    const reserved = (await r.json()) as UploadUrlResponse;
    const put = await api(reserved.uploadUrl, {
      method: "PUT",
      cookie: admin,
      headers: { "Content-Type": reserved.contentType },
      body: bytes,
    });
    expect(put.status).toBe(201);
    const set = await mutate(showId, admin, [
      {
        op: "update",
        table: "script_versions",
        id: vid,
        fields: { attachment_id: reserved.attachmentId },
      },
    ]);
    expect(set.status).toBe(200);
    let snap = await snapshot(showId, admin);
    expect(snap.tables.script_versions[0]?.attachment_id).toBe(reserved.attachmentId);
    expect(snap.tables.attachments[0]).toMatchObject({
      table: "script_versions",
      record_id: vid,
      field: "source_file",
      content_type: DOCX_TYPE,
    });
    // Only a file of this version can be linked.
    const [cue] = await createCues(showId, admin, 1);
    expect(
      (
        await mutate(showId, admin, [
          {
            op: "update",
            table: "script_versions",
            id: vid,
            fields: { attachment_id: cue as string },
          },
        ])
      ).status,
    ).toBe(400);
    // Deleting the version deletes its file.
    await mutate(showId, admin, [{ op: "delete", table: "script_versions", id: vid }]);
    snap = await snapshot(showId, admin);
    expect(snap.tables.attachments).toHaveLength(0);
    expect(snap.tables.scripts[0]?.current_version_id).toBeNull();
  });

  it("seeds the anchor states and the cues' Cut status", async () => {
    const { admin, showId } = await setup();
    const snap = await snapshot(showId, admin);
    expect(snap.fieldOptions["cue_anchors.state"]?.map((o) => o.value)).toEqual([
      "matched",
      "moved",
      "changed",
      "missing",
      "manual",
    ]);
    expect(snap.fieldOptions["cues.status"]?.at(-1)).toEqual({ value: "Cut", color: "red" });
  });
});
