// Airtable import of the real Some Like It Hot export (examples/), through the API route.
import { describe, expect, it } from "vitest";
import breakdown from "../../examples/Breakdown-Grid view.csv?raw";
import content from "../../examples/Content-Grid view.csv?raw";
import cueList from "../../examples/Cue List-Video Cue List View.csv?raw";
import notes from "../../examples/Notes-NOTES.csv?raw";
import personnel from "../../examples/Personnel-Grid view.csv?raw";
import type { HistoryResponse, ImportResponse, SnapshotResponse } from "../../src/shared/ops";
import { parseCsv } from "../../src/worker/import/airtable";
import {
  api,
  collect,
  createShow,
  isType,
  loginAdmin,
  newUser,
  ORIGIN,
  post,
  WS_HEADERS,
} from "./helpers";

const FILES: [string, string][] = [
  ["Breakdown-Grid view.csv", breakdown],
  ["Personnel-Grid view.csv", personnel],
  ["Content-Grid view.csv", content],
  ["Cue List-Video Cue List View.csv", cueList],
  ["Notes-NOTES.csv", notes],
];

function importForm(files = FILES): FormData {
  const form = new FormData();
  for (const [name, text] of files)
    form.append("files", new File([text], name, { type: "text/csv" }));
  return form;
}

function importCsv(showId: string, cookie: string, form = importForm(), query = "") {
  return api(`/api/shows/${showId}/import/airtable${query}`, {
    method: "POST",
    body: form,
    cookie,
    headers: { Origin: ORIGIN },
  });
}

describe("Airtable import", () => {
  it("parses the Notes export (quoted multi-line cells) to 319 rows", () => {
    expect(parseCsv(notes).rows).toHaveLength(319);
    expect(parseCsv(cueList).rows).toHaveLength(122);
  });

  it("imports the example base with links, scenes and history", async () => {
    const cookie = await loginAdmin();
    const show = await createShow(cookie, "Some Like It Hot");
    const wsRes = await api(`/api/shows/${show.id}/ws`, { cookie, headers: WS_HEADERS });
    const sock = collect(wsRes.webSocket as WebSocket);
    await sock.next(isType("version"));

    const res = await importCsv(show.id, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResponse;
    // 122 cue rows minus the 2 blank spacer rows.
    expect(body.created).toEqual({
      scenes: 28,
      cues: 120,
      content: 42,
      content_versions: 20,
      notes: 319,
      persons: 31,
      surfaces: 0,
    });
    expect(body.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/cue number 49.00 is used 2 times/),
        "Created person 'Casey Brennan' (not in Personnel)",
        expect.stringMatching(/cues without content took their scene from the cues around them/),
        expect.stringMatching(/cues have no scene/),
      ]),
    );

    // The import is too big to broadcast as ops: sockets get a version bump instead.
    const bump = await sock.next(isType("version"));
    expect(bump.version).toBeGreaterThan(0);
    sock.ws.close(1000);

    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    expect(snap.version).toBe(bump.version);
    const { scenes, cues, content: items, notes: noteRows, persons } = snap.tables;
    expect([scenes.length, cues.length, items.length, noteRows.length, persons.length]).toEqual([
      28, 120, 42, 319, 31,
    ]);
    // CSV order is show order.
    expect(cues.slice(0, 6).map((c) => c.number)).toEqual([
      "0.10",
      "0.30",
      "0.80",
      "0.90",
      "51.50",
      "1.00",
    ]);
    // Airtable's Version column: one current version record per content item that had one.
    const versions = snap.tables.content_versions;
    expect(versions).toHaveLength(20);
    expect(versions.every((v) => v.is_current)).toBe(true);
    expect(new Set(versions.map((v) => v.content_id)).size).toBe(20);
    const vampRow = items.find((c) => c.name === "105-001-VAMP");
    expect(versions.find((v) => v.content_id === vampRow?.id)).toMatchObject({
      version: "V02",
      is_current: true,
      status: "Available",
    });
    expect(body.warnings.some((w) => /Version values not imported/.test(w))).toBe(false);
    expect(scenes[0]).toMatchObject({ number: "99", name: "Preshow" });
    expect(scenes[2]).toMatchObject({
      number: "101",
      name: "Scene One: Hottest Speakeasy in Chicago",
    });

    // Cue 14.20 plays 105-001-VAMP and so belongs to scene 105.
    const vamp = items.find((c) => c.name === "105-001-VAMP");
    const cue1420 = cues.find((c) => c.number === "14.20");
    expect(snap.joins.cueContent[cue1420?.id ?? ""]).toEqual([vamp?.id]);
    const scene105 = scenes.find((s) => s.number === "105");
    expect(cue1420?.scene_id).toBe(scene105?.id);
    expect(vamp?.scene_id).toBe(scene105?.id);
    // Its assignee isn't in Personnel, so the importer created that person.
    const morgan = persons.find((p) => p.name === "Morgan Ellis");
    expect(morgan).toMatchObject({ group: null, email: null });
    expect(snap.joins.cueAssignees[cue1420?.id ?? ""]).toEqual([morgan?.id]);
    expect(persons.filter((p) => p.name === "Morgan Ellis")).toHaveLength(1);

    // 2.10 has no content; the cues around it are both in the Overture, so it is too.
    const overture = scenes.find((s) => s.number === "100");
    expect(overture?.name).toBe("Overture");
    expect(cues.find((c) => c.number === "2.00")?.scene_id).toBe(overture?.id);
    expect(cues.find((c) => c.number === "2.10")?.scene_id).toBe(overture?.id);
    // Cues at the very top have nothing before them and stay Unassigned.
    expect(cues.find((c) => c.number === "0.10")?.scene_id).toBeNull();

    expect(cue1420).toMatchObject({
      page: "17",
      timecode: "4:00:00.00",
      ae_time: "00:00:21:28",
      is_section: false,
    });

    // Note "scale moon up…" links cue 4.00, scene 101 and the overture content.
    const moon = noteRows.find((n) => n.body?.startsWith("scale moon up"));
    const cue400 = cues.find((c) => c.number === "4.00");
    expect(snap.joins.noteCues[moon?.id ?? ""]).toEqual([cue400?.id]);
    expect(moon).toMatchObject({
      status: "Done",
      type: ["Content"],
      scene_id: scenes[2]?.id,
      content_id: items.find((c) => c.name === "101-001-OVERTURETHIRSTYFOR")?.id,
      created_at: Date.UTC(2026, 8, 10, 17, 20),
      custom: { created_by_name: "Casey Brennan" },
    });

    // Select values map case-insensitively; Cast → person group.
    expect(cues.find((c) => c.number === "1.00")?.status).toBe("Cued");
    expect(persons.find((p) => p.name === "Jamie Petrova")?.group).toBe("Cast");
    expect(persons.find((p) => p.name === "Quinn Weller")?.email).toBe("quinn.weller@example.com");
    const multiType = noteRows.find((n) => n.type.length === 2);
    expect(multiType?.type).toEqual(["Stage Management", "Content"]);

    // History has the creates.
    const hist = (await (
      await api(`/api/shows/${show.id}/history?table=cues&id=${cue1420?.id}`, { cookie })
    ).json()) as HistoryResponse;
    expect(hist.changes.map((h) => h.field)).toEqual(["assignees", "content", "*"]);
    expect(hist.changes[0]?.userName).toBe("Admin");
  });

  it("only editors and owners may import", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const u = await newUser(admin);
    await post(`/api/shows/${show.id}/members`, { email: u.email, role: "commenter" }, admin);
    expect((await importCsv(show.id, u.cookie)).status).toBe(403);
    // Unrecognised files are skipped with a warning; no files at all is a 400.
    const res = await importCsv(show.id, admin, importForm([["random.csv", "a,b\n1,2\n"]]));
    expect(res.status).toBe(200);
    expect(((await res.json()) as ImportResponse).warnings[0]).toMatch(/random.csv: not one of/);
    expect((await importCsv(show.id, admin, new FormData())).status).toBe(400);
  });

  it("refuses to import into a show that has data unless asked to append", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const small = (): FormData =>
      importForm([["Breakdown-Grid view.csv", "Scene Name,Location\n101 Speakeasy,Chicago\n"]]);
    expect((await importCsv(show.id, admin, small())).status).toBe(200);

    const again = await importCsv(show.id, admin, small());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Show already has data" });

    const appended = await importCsv(show.id, admin, small(), "?append=1");
    expect(appended.status).toBe(200);
    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie: admin })
    ).json()) as SnapshotResponse;
    expect(snap.tables.scenes.map((s) => s.name)).toEqual(["Speakeasy", "Speakeasy"]);
  });

  it("rejects import bodies over 4 MB with 413", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const huge = `Scene Name,Location\n${"x".repeat(4 * 1024 * 1024)}\n`;
    const res = await importCsv(show.id, admin, importForm([["Breakdown-Grid view.csv", huge]]));
    expect(res.status).toBe(413);
  });
});
