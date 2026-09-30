// Script import through the API (R20, M4a): turn the txt fixture into script text (a
// minimal version of the browser's extractor: e2e can't import src/), post it as a
// version, upload the original file to it, read the text back, and re-anchor a cue on a
// second version. The reader UI (M4b) has its own specs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCreateShow, apiLogin, ORIGIN, recordId, uniqueName } from "./helpers";

const FIXTURE = path.join("e2e", "fixtures", "script.txt");

interface ScriptText {
  blocks: { i: number; page: number; kind: string; text: string }[];
  pages: { page: number; label: string }[];
  source: "txt";
  confidence: number;
}

interface CreateResponse {
  versionId: string;
  results: { cueId: string; state: string; confidence: number }[];
}

/** Blank-line paragraphs; `--- page N ---` lines start labelled pages. */
function textOf(source: string): ScriptText {
  const blocks: ScriptText["blocks"] = [];
  const pages: ScriptText["pages"] = [];
  for (const chunk of source.split(/\n\s*\n/)) {
    for (const line of chunk.split("\n")) {
      const m = /^--- page (\S+) ---$/.exec(line.trim());
      if (m) pages.push({ page: pages.length + 1, label: m[1] as string });
    }
    const text = chunk
      .split("\n")
      .filter((l) => !/^--- page/.test(l.trim()))
      .join(" ")
      .replace(/\u2019/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) blocks.push({ i: blocks.length, page: pages.length, kind: "other", text });
  }
  return { blocks, pages, source: "txt", confidence: 1 };
}

/** An anchor on a whole block: quote + 32 characters of context (blocks joined by a space). */
function anchorOn(t: ScriptText, block: number) {
  const joined = t.blocks.map((b) => b.text).join(" ");
  const start = t.blocks.slice(0, block).reduce((n, b) => n + b.text.length + 1, 0);
  const quote = (t.blocks[block] as { text: string }).text;
  const end = start + quote.length;
  return {
    block,
    offset: 0,
    length: quote.length,
    quote,
    prefix: joined.slice(Math.max(0, start - 32), start),
    suffix: joined.slice(end, end + 32),
  };
}

test("imports a script version, stores its file and text, re-anchors on the next", async ({
  page,
}) => {
  await apiLogin(page);
  const showId = await apiCreateShow(page, uniqueName("Script import"));
  const source = readFileSync(FIXTURE, "utf8");
  const text = textOf(source);
  expect(text.pages.map((p) => p.label)).toEqual(["1", "2"]);

  const versionId = recordId();
  const created = await page.request.post(`/api/shows/${showId}/script/versions`, {
    data: { versionId, label: "Rehearsal draft", text },
  });
  expect(created.status(), await created.text()).toBe(201);
  expect(((await created.json()) as CreateResponse).versionId).toBe(versionId);

  // The original file goes to the version through the attachments pipeline.
  const bytes = readFileSync(FIXTURE);
  const reserve = await page.request.post(`/api/shows/${showId}/attachments/upload-url`, {
    data: {
      table: "script_versions",
      recordId: versionId,
      field: "source_file",
      filename: "script.txt",
      contentType: "text/plain",
      size: bytes.length,
    },
  });
  expect(reserve.status(), await reserve.text()).toBe(200);
  const { attachmentId, uploadUrl } = (await reserve.json()) as {
    attachmentId: string;
    uploadUrl: string;
  };
  const put = await page.request.put(uploadUrl, {
    data: bytes,
    headers: { "Content-Type": "text/plain", Origin: ORIGIN },
  });
  expect(put.status()).toBe(201);
  const link = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [
        {
          op: "update",
          table: "script_versions",
          id: versionId,
          fields: { attachment_id: attachmentId },
        },
      ],
    },
  });
  expect(link.status()).toBe(200);

  // The text comes back exactly as extracted.
  const got = await page.request.get(`/api/shows/${showId}/script/versions/${versionId}/text`);
  expect(got.status()).toBe(200);
  expect((await got.json()) as ScriptText).toEqual(text);

  // A cue anchored on Joe's line follows it into a version with a new first page.
  const cueId = recordId();
  const sue = text.blocks.findIndex((b) => b.text.includes("Sweet Sue"));
  expect(sue).toBeGreaterThan(0);
  const a = anchorOn(text, sue);
  const placed = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [
        { op: "create", table: "cues", id: cueId, fields: { number: "1" } },
        {
          op: "create",
          table: "cue_anchors",
          id: recordId(),
          fields: { cue_id: cueId, script_version_id: versionId, ...a, state: "manual" },
        },
      ],
    },
  });
  expect(placed.status(), await placed.text()).toBe(200);
  const v2 = textOf(`--- page i ---\nPROLOGUE\n\nThe band tunes up.\n\n${source}`);
  const next = await page.request.post(`/api/shows/${showId}/script/versions`, {
    data: { label: "v2", text: v2 },
  });
  expect(next.status()).toBe(201);
  const body = (await next.json()) as CreateResponse;
  expect(body.results).toHaveLength(1);
  // Same printed page ("1"), same place in the text: matched, though it moved down a page.
  expect(body.results[0]).toMatchObject({ cueId, state: "matched", confidence: 1 });
  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: { cues: { id: string; page: string | null }[] };
  };
  expect(snap.tables.cues.find((c) => c.id === cueId)?.page).toBe("1");
});
