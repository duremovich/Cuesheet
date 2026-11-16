// Script markers call out what the SM calls the cue on, in full (R20/R21): the SM call
// first (else the trigger text, else the description), no bare trigger-type badge
// (VISUAL, LINE…: the tick / underline shows the type), a long call wrapping instead of
// being cut, and stacked markers never overlapping. Checked in the text view, the PDF page
// view and both calling-script prints. Cues and anchors are seeded through the API.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { apiCreateShow, apiLogin, recordId, trackErrors, uniqueName } from "./helpers";

let errors: string[] = [];
const pages: Page[] = [];

test.beforeEach(() => {
  errors = [];
  pages.length = 0;
});

test.afterEach(async () => {
  expect(errors, "console errors").toEqual([]);
  for (const p of pages) await p.context().close();
});

async function newPage(browser: Browser) {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  ).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

const LONG_CALL =
  "Transition DAY to LATE FRIDAY NIGHT: the band packs up, the porch light flickers twice " +
  "and the last of the sunset drains off the ridge behind the cabin";
const SHORT_CALL = "Top of Show Sequence";

interface ScriptText {
  blocks: { i: number; page: number; kind: string; text: string }[];
  pages: { page: number; label: string }[];
  source: string;
  confidence: number;
}

async function mutate(page: Page, showId: string, ops: unknown[]) {
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function currentVersion(page: Page, showId: string): Promise<string> {
  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: { script_versions: { id: string }[] };
  };
  const v = snap.tables.script_versions[0];
  if (!v) throw new Error("no script version");
  return v.id;
}

async function versionText(page: Page, showId: string, versionId: string) {
  const res = await page.request.get(`/api/shows/${showId}/script/versions/${versionId}/text`);
  expect(res.status()).toBe(200);
  return (await res.json()) as ScriptText;
}

/** A positional anchor at the start of a block (its quote: the block's first words). */
function positionAt(t: ScriptText, block: number) {
  const text = (t.blocks[block] as { text: string }).text;
  const quote = text.split(" ").slice(0, 3).join(" ");
  return { block, offset: 0, length: quote.length, quote, prefix: "", suffix: "" };
}

/**
 * Three Visual cues, all with an SM call and a (different) description: Q 1 (the long
 * call) and Q 2 on `first`, Q 3 on `second`, the very next block, so a tall Q 1 has to
 * push the others down.
 */
async function seedCues(page: Page, showId: string, t: ScriptText, first: number, second: number) {
  const versionId = await currentVersion(page, showId);
  const ids = { q1: recordId(), q2: recordId(), q3: recordId() };
  const cue = (id: string, number: string, sm_call: string) => ({
    op: "create",
    table: "cues",
    id,
    fields: {
      number,
      trigger_type: "Visual",
      sm_call,
      description: `Design note for ${number}: not what the SM calls`,
    },
  });
  const anchor = (cueId: string, block: number) => ({
    op: "create",
    table: "cue_anchors",
    id: recordId(),
    fields: {
      cue_id: cueId,
      script_version_id: versionId,
      ...positionAt(t, block),
      state: "manual",
    },
  });
  await mutate(page, showId, [
    cue(ids.q1, "1", LONG_CALL),
    cue(ids.q2, "2", `[${SHORT_CALL}]`),
    cue(ids.q3, "3", "GO on the blackout"),
    anchor(ids.q1, first),
    anchor(ids.q2, first),
    anchor(ids.q3, second),
  ]);
  return ids;
}

type Box = { top: number; bottom: number; left: number; right: number };

async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }),
  );
}

function expectNoOverlap(list: Box[]) {
  const sorted = [...list].sort((a, b) => a.top - b.top);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1] as Box;
    const cur = sorted[k] as Box;
    expect(cur.top, "markers overlap").toBeGreaterThanOrEqual(prev.bottom - 0.5);
  }
}

test("script text view: markers call out the SM call in full, no type badge, no overlaps", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Callout text"));
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles("e2e/fixtures/script-v1.txt");
  await expect(page.getByTestId("import-preview")).toContainText("3 pages");
  await page.getByLabel("Version label").fill("v1");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();

  const t = await versionText(page, showId, await currentVersion(page, showId));
  const joe = t.blocks.findIndex((b) => b.text.startsWith("JOE"));
  const ids = await seedCues(page, showId, t, joe, joe + 1);

  const m1 = page.locator(`[data-testid="script-marker"][data-cue="${ids.q1}"]`);
  await expect(m1).toBeVisible();
  // The whole SM call, not the description, and no "VISUAL".
  await expect(m1.getByTestId("marker-text")).toHaveText(LONG_CALL);
  await expect(m1).not.toContainText("VISUAL");
  await expect(m1).not.toContainText("Design note");
  // Brackets around an imported SM call are dropped.
  await expect(
    page.locator(`[data-testid="script-marker"][data-cue="${ids.q2}"]`).getByTestId("marker-text"),
  ).toHaveText(SHORT_CALL);
  // The description is still there on hover.
  await expect(m1.locator("button").first()).toHaveAttribute(
    "title",
    `${LONG_CALL}\nDesign note for 1: not what the SM calls`,
  );
  // Nothing clipped: the text wraps and the marker grows to hold it.
  const clip = await m1.evaluate((el) => {
    const text = el.querySelector('[data-testid="marker-text"]') as HTMLElement;
    return {
      lines: Math.round(text.getBoundingClientRect().height / 15),
      overflowY: el.scrollHeight - el.clientHeight,
      overflowX: text.scrollWidth - text.clientWidth,
      textBottom: text.getBoundingClientRect().bottom,
      markerBottom: el.getBoundingClientRect().bottom,
    };
  });
  expect(clip.lines).toBeGreaterThan(1);
  expect(clip.overflowY).toBeLessThanOrEqual(1);
  expect(clip.overflowX).toBeLessThanOrEqual(1);
  expect(clip.textBottom).toBeLessThanOrEqual(clip.markerBottom + 0.5);
  // The stack makes room for the tall marker.
  expectNoOverlap(await boxes(page, '[data-testid="script-margin"] [data-testid="script-marker"]'));
  await page.screenshot({ path: "test-results/script-callout-text.png" });

  // --- Print: the same callout, in full, no type badge ---
  await page.goto(`/shows/${showId}/script/print`);
  const printed = page.getByTestId("print-marker").filter({ hasText: "Q 1" }).first();
  await expect(printed).toContainText(LONG_CALL);
  await expect(printed).not.toContainText("VISUAL");
});

/** Two pages with printed labels 12 and 13: a speech, then directions two lines below. */
async function cabinPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const content: [string, [number, string, PDFFont?][]][] = [
    [
      "12",
      [
        [260, "ACT ONE"],
        [100, "A cabin porch. Late afternoon.", italic],
        [0, ""],
        [280, "MICAH"],
        [150, "What a sound that river makes."],
        [0, ""],
        [100, "The light starts to go.", italic],
      ],
    ],
    [
      "13",
      [
        [280, "RUTH"],
        [150, "Get the lantern."],
      ],
    ],
  ];
  for (const [label, lines] of content) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (const [x, text, font] of lines) {
      if (text) page.drawText(text, { x, y, size: 12, font: font ?? roman });
      y -= 14;
    }
  }
  return Buffer.from(await doc.save());
}

test("script PDF view: leader labels call out the SM call in full, wrapped, no overlaps", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Callout PDF"));
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "cabin.pdf",
    mimeType: "application/pdf",
    buffer: await cabinPdf(),
  });
  await expect(page.getByTestId("import-preview")).toContainText("2 pages", { timeout: 20_000 });
  await page.getByLabel("Version label").fill("v1");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("pdf-view")).toBeVisible();

  const t = await versionText(page, showId, await currentVersion(page, showId));
  const speech = t.blocks.findIndex((b) => b.text.includes("What a sound"));
  const light = t.blocks.findIndex((b) => b.text.includes("The light starts"));
  expect(speech, JSON.stringify(t.blocks.map((b) => b.text))).toBeGreaterThan(0);
  expect(light).toBeGreaterThan(speech);
  const ids = await seedCues(page, showId, t, speech, light);

  await expect(page.locator('[data-testid="pdf-page"][data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
    { timeout: 20_000 },
  );
  const e1 = page.locator(`[data-testid="pdf-marker"][data-cue="${ids.q1}"]`);
  const label = e1.getByTestId("pdf-marker-label");
  await expect(label).toBeVisible();
  // Every word of the call, over several lines; no "VISUAL", not the description.
  await expect(label).toHaveText(LONG_CALL);
  expect(await label.locator("span").count()).toBeGreaterThan(1);
  await expect(label).not.toContainText("VISUAL");
  await expect(
    page
      .locator(`[data-testid="pdf-marker"][data-cue="${ids.q2}"]`)
      .getByTestId("pdf-marker-label"),
  ).toHaveText(SHORT_CALL);
  // Each line stays clear of the number box, inside the entry.
  const fit = await e1.evaluate((el) => {
    const n = (
      el.querySelector('[data-testid="pdf-cue-number"]') as HTMLElement
    ).getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const spans = Array.from(el.querySelectorAll('[data-testid="pdf-marker-label"] span'));
    return spans.map((s) => {
      const r = s.getBoundingClientRect();
      return { right: r.right, numberLeft: n.left, bottom: r.bottom, entryBottom: box.bottom };
    });
  });
  for (const f of fit) {
    expect(f.right).toBeLessThanOrEqual(f.numberLeft);
    expect(f.bottom).toBeLessThanOrEqual(f.entryBottom + 0.5);
  }
  // Entries on the page don't overlap, the tall one included.
  expectNoOverlap(await boxes(page, '[data-page="1"] [data-testid="pdf-marker"]'));
  await page.screenshot({ path: "test-results/script-callout-pdf.png" });

  // --- Print (PDF layout): the whole call, in wrapped lines ---
  await page.goto(`/shows/${showId}/script/print?layout=pdf`);
  await expect(page.getByTestId("print-pdf")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  const printed = page.getByTestId("print-pdf-label");
  await expect(printed).toHaveCount(3);
  const printedLines = await printed.evaluateAll((els) =>
    els.map((el) => Array.from(el.querySelectorAll("tspan")).map((s) => s.textContent ?? "")),
  );
  const long = printedLines.find((l) => l.join(" ") === LONG_CALL);
  expect(long, JSON.stringify(printedLines)).toBeDefined();
  expect(long?.length).toBeGreaterThan(1);
  // The printed entries (label + number box) don't overlap either.
  const entries = await page.getByTestId("print-pdf-marker").evaluateAll((els) =>
    els.map((g) => {
      const parts = Array.from(g.querySelectorAll('rect, [data-testid="print-pdf-label"]'));
      const rs = parts.map((p) => p.getBoundingClientRect());
      return {
        top: Math.min(...rs.map((r) => r.top)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
        left: Math.min(...rs.map((r) => r.left)),
        right: Math.max(...rs.map((r) => r.right)),
      };
    }),
  );
  expect(entries).toHaveLength(3);
  expectNoOverlap(entries);
});
