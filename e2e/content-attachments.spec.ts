// M3a: content versions (R10), attachments in R2 with thumbnails (R13, S4) and the gallery
// view (R19), on the Some Like It Hot example imported into a fresh show per test.
import { deflateSync } from "node:zlib";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addMember,
  apiCreateShow,
  apiLogin,
  importExamples,
  recordId,
  trackErrors,
  uniqueName,
} from "./helpers";

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

// ---- a PNG of any size (RGB), for uploads ----
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = (x + y) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- setup ----
async function newPage(browser: Browser, viewport = { width: 1400, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

interface Snap {
  tables: {
    cues: { id: string; number: string | null }[];
    content: { id: string; name: string | null }[];
    content_versions: { id: string; content_id: string; version: string; is_current: boolean }[];
    attachments: {
      id: string;
      table: string;
      record_id: string;
      filename: string;
      custom: Record<string, unknown>;
    }[];
    notes: { id: string; body: string | null }[];
  };
  joins: { cueContent: Record<string, string[]> };
}

async function snap(page: Page, showId: string): Promise<Snap> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Snap;
}

/** A show with the example imported; VAMP (105-001) and a cue that plays it. */
async function exampleShow(browser: Browser, viewport?: { width: number; height: number }) {
  const page = await newPage(browser, viewport);
  const showId = await apiCreateShow(page, uniqueName("Attachments"));
  await importExamples(page, showId);
  const s = await snap(page, showId);
  const vamp = s.tables.content.find((c) => c.name === "105-001-VAMP");
  if (!vamp) throw new Error("no VAMP");
  const cueId = Object.entries(s.joins.cueContent).find(([, ids]) => ids.includes(vamp.id))?.[0];
  const cue = s.tables.cues.find((c) => c.id === cueId);
  if (!cue?.number) throw new Error("no cue plays VAMP");
  return { page, showId, vampId: vamp.id, cueId: cue.id, cueNumber: cue.number };
}

const contentRow = (page: Page, id: string) =>
  page.getByRole("grid", { name: "Content list", exact: true }).locator(`[data-row-id="${id}"]`);
const cueRow = (page: Page, id: string) =>
  page.getByRole("grid", { name: "Cue list" }).locator(`[data-row-id="${id}"]`);

/** Opens the content tab at a row and its panel. */
async function openContentPanel(page: Page, showId: string, id: string) {
  await page.goto(`/shows/${showId}/content?content=${id}`);
  const cell = contentRow(page, id).locator('[data-col="name"]');
  await expect(cell).toHaveAttribute("data-active", "true");
  await cell.click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("105-001-VAMP");
  return panel;
}

/** Drop files onto an element the way a browser does (dragover, then drop). */
async function dropFiles(target: Locator, files: { name: string; type: string; bytes: Buffer }[]) {
  const payload = files.map((f) => ({ ...f, b64: f.bytes.toString("base64") }));
  await target.evaluate((el, list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: f.type }));
    }
    el.dispatchEvent(
      new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);
}

/** Paste files into an element (a screenshot pasted from the clipboard). */
async function pasteFiles(target: Locator, files: { name: string; type: string; bytes: Buffer }[]) {
  const payload = files.map((f) => ({ ...f, b64: f.bytes.toString("base64") }));
  await target.evaluate((el, list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: f.type }));
    }
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, payload);
}

/** The image has loaded (a real thumbnail, not a broken image). */
async function expectLoaded(img: Locator) {
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

const RED = png(640, 480, [220, 30, 40]);
const BLUE = png(300, 200, [30, 60, 220]);

test("versions: add one, the cue chip shows it, set another current, delete with undo", async ({
  browser,
}) => {
  const { page, showId, vampId, cueId } = await exampleShow(browser);
  const panel = await openContentPanel(page, showId, vampId);
  await panel.getByRole("tab", { name: /Versions/ }).click();
  const versions = panel.getByTestId("version");
  // The import's Airtable Version "2.0" is V02, current.
  await expect(versions).toHaveCount(1);
  await expect(versions.first().getByRole("textbox", { name: "Version", exact: true })).toHaveValue(
    "V02",
  );
  await expect(versions.first()).toHaveAttribute("data-current", "true");

  await panel.getByRole("button", { name: "+ Add version" }).click();
  await expect(versions).toHaveCount(2);
  // Newest first: V03, current, today, Available.
  const v03 = versions.first();
  await expect(v03.getByRole("textbox", { name: "Version", exact: true })).toHaveValue("V03");
  await expect(v03).toHaveAttribute("data-current", "true");
  await expect(v03.getByRole("combobox").first()).toHaveValue("Available");
  await expect(versions.nth(1)).not.toHaveAttribute("data-current", "true");
  await expect(contentRow(page, vampId).locator('[data-col="version"]')).toHaveText("V03");

  // Edit in place: the changes note.
  await v03.getByLabel("Changes").fill("warmer sky");
  await v03.getByLabel("Changes").press("Enter");
  await expect
    .poll(async () => {
      const s = await snap(page, showId);
      return s.tables.content_versions.find((v) => v.version === "V03" && v.content_id === vampId);
    })
    .toMatchObject({ is_current: true });

  // The cue list's content chip carries the current version.
  await page.goto(`/shows/${showId}/cues?cue=${cueId}`);
  const chip = cueRow(page, cueId).locator('[data-col="content"]');
  await expect(chip).toContainText("105-001-VAMP · V03");

  // Set V02 current again: the chip follows.
  await page.goBack();
  const panel2 = page.getByTestId("row-panel");
  if (!(await panel2.isVisible())) {
    await contentRow(page, vampId).locator('[data-col="name"]').click();
    await page.keyboard.press("Space");
  }
  await panel2.getByRole("tab", { name: /Versions/ }).click();
  await panel2.getByTestId("version").nth(1).getByRole("button", { name: "Set current" }).click();
  await expect(panel2.getByTestId("version").nth(1)).toHaveAttribute("data-current", "true");
  await expect(panel2.getByTestId("version").first()).not.toHaveAttribute("data-current", "true");
  await expect(contentRow(page, vampId).locator('[data-col="version"]')).toHaveText("V02");

  // Delete V03 with Undo: it comes back.
  await panel2.getByRole("button", { name: "Delete version V03" }).click();
  await expect(panel2.getByTestId("version")).toHaveCount(1);
  await page
    .getByTestId("toast")
    .filter({ hasText: "Version V03 deleted." })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(panel2.getByTestId("version")).toHaveCount(2);
  await expect(panel2.getByTestId("version").first().getByLabel("Changes")).toHaveValue(
    "warmer sky",
  );

  await page.goto(`/shows/${showId}/cues?cue=${cueId}`);
  await expect(cueRow(page, cueId).locator('[data-col="content"]')).toContainText(
    "105-001-VAMP · V02",
  );
});

test("attachments: drop a PNG on the content cell, thumbnails everywhere, lightbox, delete with undo", async ({
  browser,
}) => {
  const { page, showId, vampId, cueId } = await exampleShow(browser);
  await page.goto(`/shows/${showId}/content?content=${vampId}`);
  const cell = contentRow(page, vampId).locator('[data-col="attachments"]');
  await expect(cell).toBeVisible();
  await dropFiles(cell, [{ name: "vamp-still.png", type: "image/png", bytes: RED }]);
  const thumb = cell.getByTestId("thumb").locator("img");
  await expectLoaded(thumb);
  await expect(thumb).toHaveAttribute("alt", "vamp-still.png");
  // The Worker made a real thumbnail (320 px wide).
  const src = (await thumb.getAttribute("src")) ?? "";
  expect(src).toMatch(/\/thumb$/);
  expect(await thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);

  // A second file through the panel's field.
  await cell.click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  const field = panel.getByTestId("attachments-field");
  await field.getByTestId("attachment-input").setInputFiles({
    name: "vamp-alt.png",
    mimeType: "image/png",
    buffer: BLUE,
  });
  await expect(field.getByTestId("attachment")).toHaveCount(2);
  await expect(cell.getByTestId("thumb")).toHaveCount(2);

  // Reorder in the panel: the second goes first (the grid's first thumb follows).
  await field.getByRole("button", { name: "Move vamp-alt.png earlier" }).click();
  await expect(field.getByTestId("attachment").first()).toContainText("vamp-alt.png");
  await expect(cell.getByTestId("thumb").first().locator("img")).toHaveAttribute(
    "alt",
    "vamp-alt.png",
  );
  await field.getByRole("button", { name: "Move vamp-alt.png later" }).click();
  await expect(field.getByTestId("attachment").first()).toContainText("vamp-still.png");

  // Images show full width in the panel with an editable caption (the file name until set).
  await expectLoaded(field.getByTestId("attachment-image").first());
  const caption = field.getByRole("textbox", { name: "Caption for vamp-still.png" });
  await expect(caption).toHaveValue("vamp-still.png");
  await caption.fill("Vamp, act one");
  await caption.press("Enter");
  await expect
    .poll(async () => {
      const a = (await snap(page, showId)).tables.attachments.find(
        (f) => f.filename === "vamp-still.png",
      );
      return a?.custom;
    })
    .toMatchObject({ caption: "Vamp, act one" });
  // Escape reverts a caption being typed.
  await caption.fill("nope");
  await caption.press("Escape");
  await expect(caption).toHaveValue("Vamp, act one");

  // Lightbox from the grid: prev / next with the arrow keys and buttons.
  await cell.getByRole("button", { name: "Open vamp-still.png" }).click();
  const lightbox = page.getByTestId("lightbox");
  await expect(lightbox.getByTestId("lightbox-filename")).toHaveText("vamp-still.png");
  await expect(lightbox.getByTestId("lightbox-caption")).toHaveText("Vamp, act one");
  await expect(lightbox.getByTestId("lightbox-count")).toContainText("1 / 2");
  await expectLoaded(lightbox.getByTestId("lightbox-image"));
  await page.keyboard.press("ArrowRight");
  await expect(lightbox.getByTestId("lightbox-filename")).toHaveText("vamp-alt.png");
  await lightbox.getByRole("button", { name: "Previous file" }).click();
  await expect(lightbox.getByTestId("lightbox-filename")).toHaveText("vamp-still.png");
  const download = lightbox.getByRole("link", { name: "Download" });
  const dl = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-disposition"]).toMatch(/^attachment;/);
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  // The cue's content chip and the cue panel's content card show the thumbnail.
  await page.goto(`/shows/${showId}/cues?cue=${cueId}`);
  const cueCell = cueRow(page, cueId).locator('[data-col="number"]');
  await expect(cueCell).toHaveAttribute("data-active", "true");
  await expectLoaded(cueRow(page, cueId).getByTestId("chip-thumb"));
  await cueCell.click();
  await page.keyboard.press("Space");
  const cuePanel = page.getByTestId("row-panel");
  await cuePanel.getByRole("tab", { name: /Content/ }).click();
  const card = cuePanel.getByTestId("content-card").filter({ hasText: "105-001-VAMP" });
  await expectLoaded(card.getByTestId("thumb").locator("img"));

  // Delete from the lightbox: sent at once; Undo brings the same file back (the server
  // keeps deleted files in R2 for a day).
  await page.goto(`/shows/${showId}/content?content=${vampId}`);
  await contentRow(page, vampId)
    .locator('[data-col="attachments"]')
    .getByRole("button", { name: "Open vamp-alt.png" })
    .click();
  await lightbox.getByRole("button", { name: "Delete" }).click();
  await expect(contentRow(page, vampId).getByTestId("thumb")).toHaveCount(1);
  const files = async (): Promise<string[]> =>
    (await snap(page, showId)).tables.attachments.map((a) => a.filename).sort();
  await expect.poll(files).toEqual(["vamp-still.png"]);
  await page
    .getByTestId("toast")
    .filter({ hasText: "Deleted vamp-alt.png." })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(contentRow(page, vampId).getByTestId("thumb")).toHaveCount(2);
  await expect.poll(files).toEqual(["vamp-alt.png", "vamp-still.png"]);
  await expectLoaded(
    contentRow(page, vampId).getByRole("button", { name: "Open vamp-alt.png" }).locator("img"),
  );
  // Deleted for good this time.
  await page.keyboard.press("Escape");
  await contentRow(page, vampId)
    .locator('[data-col="attachments"]')
    .getByRole("button", { name: "Open vamp-alt.png" })
    .click();
  await lightbox.getByRole("button", { name: "Delete" }).click();
  // The lightbox moves on to the file that's left.
  await expect(lightbox.getByTestId("lightbox-filename")).toHaveText("vamp-still.png");
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect.poll(files).toEqual(["vamp-still.png"]);
  const s = await snap(page, showId);
  expect(s.tables.attachments[0]?.record_id).toBe(vampId);

  // Storage usage in the show settings.
  await page.getByRole("button", { name: /Show settings/ }).click();
  await expect(page.getByTestId("storage-usage")).toContainText("of 2 GB used");
});

test("a photo over 16 MP is scaled down in the browser before upload; it gets a thumbnail", async ({
  browser,
}) => {
  const { page, showId, vampId } = await exampleShow(browser);
  await page.goto(`/shows/${showId}/content?content=${vampId}`);
  const cell = contentRow(page, vampId).locator('[data-col="attachments"]');
  await expect(cell).toBeVisible();
  await dropFiles(cell, [
    { name: "huge.png", type: "image/png", bytes: png(5000, 4000, [10, 200, 90]) },
  ]);
  const thumb = cell.getByTestId("thumb").locator("img");
  await expectLoaded(thumb);
  expect(await thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);
  const s = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: {
      attachments: {
        filename: string;
        width: number;
        height: number;
        custom: { original_size?: { width: number; height: number } };
      }[];
    };
  };
  expect(s.tables.attachments.find((a) => a.filename === "huge.png")).toMatchObject({
    width: 4096,
    height: 3276,
    custom: { original_size: { width: 5000, height: 4000 } },
  });
});

test("gallery: the view toggle shows cards with the image; preset view; 390 px has two columns", async ({
  browser,
}) => {
  const { page, showId, vampId } = await exampleShow(browser);
  const up = await page.request.post(`/api/shows/${showId}/attachments/upload-url`, {
    data: {
      table: "content",
      recordId: vampId,
      filename: "vamp.png",
      contentType: "image/png",
      size: RED.length,
    },
  });
  expect(up.status()).toBe(200);
  const { uploadUrl } = (await up.json()) as { uploadUrl: string };
  const put = await page.request.put(uploadUrl, {
    data: RED,
    headers: { "Content-Type": "image/png" },
  });
  expect(put.status()).toBe(201);

  await page.goto(`/shows/${showId}/content`);
  await expect(page.getByRole("grid", { name: "Content list", exact: true })).toBeVisible();
  await page.getByTestId("view-layout").click();
  const gallery = page.getByTestId("gallery");
  await expect(gallery).toBeVisible();
  await expect(page.getByRole("grid", { name: "Content list", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("view-layout")).toHaveAttribute("aria-pressed", "true");
  // Grouped by scene, like the grid.
  await expect(gallery.getByTestId("gallery-group").first()).toBeVisible();
  // Opening a row from the URL focuses its card (scrolled into the virtualized list); the
  // unsaved layout change (a draft) survives the reload.
  await page.goto(`/shows/${showId}/content?content=${vampId}`);
  const vamp = gallery.locator(`[data-card-id="${vampId}"]`);
  await expect(vamp).toBeFocused();
  await expectLoaded(vamp.getByTestId("gallery-image").locator("img"));
  await expect(vamp).toContainText("105-001-VAMP");
  // Cards without an image show their name as a placeholder; keyboard moves between cards.
  await vamp.click();
  await expect(page.getByTestId("row-panel").getByRole("heading", { level: 2 })).toHaveText(
    "105-001-VAMP",
  );
  await vamp.focus();
  await page.keyboard.press("ArrowRight");
  await expect(gallery.locator('[data-testid="gallery-card"]:focus')).not.toHaveAttribute(
    "data-card-id",
    vampId,
  );
  await page.keyboard.press("ArrowLeft");
  await expect(vamp).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("lightbox-filename")).toHaveText("vamp.png");
  await page.keyboard.press("Escape");
  // The editor's shared view is now a draft; discard it and use the preset instead.
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("grid", { name: "Content list", exact: true })).toBeVisible();
  await page.getByTestId("view-switcher").click();
  await page.getByRole("button", { name: "+ Content gallery" }).click();
  await expect(page.getByTestId("current-view")).toHaveText("Content gallery");
  await expect(page.getByTestId("gallery")).toBeVisible();

  // Phones: two columns.
  const phone = await newPage(browser, { width: 390, height: 844 });
  await phone.goto(`/shows/${showId}/content`);
  await expect(phone.getByRole("grid", { name: "Content list", exact: true })).toBeVisible();
  await phone.getByTestId("view-switcher").click();
  // The preset made on the desktop is one of my views now.
  await phone
    .getByRole("dialog", { name: "Views" })
    .getByRole("button", { name: /^Content gallery/ })
    .click();
  const g = phone.getByTestId("gallery");
  await expect(g).toHaveAttribute("data-columns", "2");
  const widths = await g
    .getByTestId("gallery-card")
    .evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().width));
  expect(widths[0]).toBeGreaterThan(150);
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("surfaces: images on a surface, in its panel and the Surface gallery", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Surface images"));
  await importExamples(page, showId, ["Surfaces-Gallery.csv"]);
  const surfaces = (
    (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
      tables: { surfaces: { id: string; name: string | null }[] };
    }
  ).tables.surfaces;
  const surface = surfaces[0];
  if (!surface) throw new Error("no surfaces");
  await page.goto(`/shows/${showId}/surfaces?surface=${surface.id}`);
  const row = page
    .getByRole("grid", { name: "Surface list" })
    .locator(`[data-row-id="${surface.id}"]`);
  const cell = row.locator('[data-col="images"]');
  await expect(cell).toBeVisible();
  await dropFiles(cell, [{ name: "wall.png", type: "image/png", bytes: RED }]);
  await expectLoaded(cell.getByTestId("thumb").locator("img"));
  await row.locator('[data-col="name"]').click();
  await page.keyboard.press("Space");
  const field = page.getByTestId("row-panel").getByTestId("attachments-field");
  await expectLoaded(field.getByTestId("attachment-image"));
  await page.keyboard.press("Escape");
  await page.getByTestId("view-switcher").click();
  await page.getByRole("button", { name: "+ Surface gallery" }).click();
  await expect(page.getByTestId("current-view")).toHaveText("Surface gallery");
  const card = page.getByTestId("gallery").locator(`[data-card-id="${surface.id}"]`);
  await expectLoaded(card.getByTestId("gallery-image").locator("img"));
});

test("notes: paste an image into the compose box; it's attached once the note is saved", async ({
  browser,
}) => {
  const { page, showId, cueId, cueNumber } = await exampleShow(browser);
  await page.goto(`/shows/${showId}/cues?cue=${cueId}`);
  const cell = cueRow(page, cueId).locator('[data-col="number"]');
  await expect(cell).toHaveAttribute("data-active", "true");
  await cell.click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(`Cue ${cueNumber}`);
  await panel.getByRole("tab", { name: /Notes/ }).click();
  const box = panel.getByRole("textbox", { name: "New note" });
  await pasteFiles(box, [{ name: "stage.png", type: "image/png", bytes: BLUE }]);
  await expect(panel.getByTestId("pending-file")).toHaveText(/stage\.png/);
  const body = uniqueName("haze too thick");
  await box.fill(body);
  await box.press("Enter");
  const note = panel.getByTestId("note").filter({ hasText: body });
  await expectLoaded(note.getByTestId("thumb").locator("img"));
  await expect(panel.getByTestId("pending-file")).toHaveCount(0);
  const s = await snap(page, showId);
  const saved = s.tables.notes.find((n) => n.body === body);
  const photos = async () =>
    (await snap(page, showId)).tables.attachments
      .filter((a) => a.record_id === saved?.id)
      .map((a) => a.filename);
  expect(await photos()).toEqual(["stage.png"]);

  // Deleting the note deletes its photo; Undo brings both back.
  await note.getByRole("button", { name: "Delete note" }).click();
  await expect(note).toHaveCount(0);
  await expect.poll(photos).toEqual([]);
  await page
    .getByTestId("toast")
    .filter({ hasText: "Note deleted." })
    .getByRole("button", { name: "Undo" })
    .click();
  await expectLoaded(note.getByTestId("thumb").locator("img"));
  await expect.poll(photos).toEqual(["stage.png"]);
});

test("quick add: the camera input attaches a photo to the saved note", async ({ browser }) => {
  const { page, showId, cueId } = await exampleShow(browser);
  const phone = await newPage(browser, { width: 390, height: 844 });
  await phone.goto(`/shows/${showId}/quick?cue=${cueId}`);
  const camera = phone.getByTestId("camera-input");
  await expect(camera).toHaveAttribute("accept", "image/*");
  await expect(camera).toHaveAttribute("capture", "environment");
  await camera.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: RED });
  await expect(phone.getByTestId("pending-file")).toHaveText(/photo\.png/);
  const body = uniqueName("from the booth");
  await phone.getByRole("textbox", { name: "Quick note" }).fill(body);
  await phone.getByRole("button", { name: "Add note" }).click();
  await expect(phone.getByRole("status").filter({ hasText: /Saved to Cue/ })).toBeVisible();
  await expect
    .poll(async () => {
      const s = await snap(page, showId);
      const n = s.tables.notes.find((x) => x.body === body);
      return s.tables.attachments.filter((a) => a.record_id === n?.id).map((a) => a.filename);
    })
    .toEqual(["photo.png"]);
});

test("quick add: a photo alone is a note; HEIC is refused before saving", async ({ browser }) => {
  const { page, showId, cueId } = await exampleShow(browser);
  const phone = await newPage(browser, { width: 390, height: 844 });
  await phone.goto(`/shows/${showId}/quick?cue=${cueId}`);
  const add = phone.getByRole("button", { name: "Add note" });
  await expect(add).toBeDisabled();
  const camera = phone.getByTestId("camera-input");
  await camera.setInputFiles({ name: "IMG_1.heic", mimeType: "image/heic", buffer: RED });
  await expect(phone.getByTestId("compose-error")).toContainText(/IMG_1\.heic/);
  await expect(phone.getByTestId("pending-file")).toHaveCount(0);
  await expect(add).toBeDisabled();
  await camera.setInputFiles({ name: "only.png", mimeType: "image/png", buffer: BLUE });
  await expect(phone.getByTestId("pending-file")).toHaveText(/only\.png/);
  await expect(add).toBeEnabled();
  await add.click();
  await expect(phone.getByRole("status").filter({ hasText: /Saved to Cue/ })).toBeVisible();
  await expect
    .poll(async () => {
      const s = await snap(page, showId);
      const ids = new Set(
        s.tables.attachments.filter((a) => a.filename === "only.png").map((a) => a.record_id),
      );
      return s.tables.notes.filter((n) => ids.has(n.id)).map((n) => n.body);
    })
    .toEqual([null]);
});

test("roles: viewers see and download but can't upload; commenters attach to their own notes only", async ({
  browser,
}) => {
  const { page, showId, vampId } = await exampleShow(browser);
  const reserve = (p: Page, table: string, id: string) =>
    p.request.post(`/api/shows/${showId}/attachments/upload-url`, {
      data: { table, recordId: id, filename: "a.png", contentType: "image/png", size: BLUE.length },
    });
  const r = await reserve(page, "content", vampId);
  const { uploadUrl } = (await r.json()) as { uploadUrl: string };
  expect(
    (
      await page.request.put(uploadUrl, { data: BLUE, headers: { "Content-Type": "image/png" } })
    ).status(),
  ).toBe(201);

  const { page: viewer } = await addMember(browser, page, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  expect((await reserve(viewer, "content", vampId)).status()).toBe(403);
  expect((await viewer.request.get(uploadUrl)).status()).toBe(200);
  await viewer.setViewportSize({ width: 1400, height: 1000 });
  await viewer.goto(`/shows/${showId}/content?content=${vampId}`);
  const cell = contentRow(viewer, vampId).locator('[data-col="attachments"]');
  await expectLoaded(cell.getByTestId("thumb").locator("img"));
  await cell.getByRole("button", { name: "Open a.png" }).click();
  const lightbox = viewer.getByTestId("lightbox");
  await expect(lightbox.getByRole("link", { name: "Download" })).toBeVisible();
  await expect(lightbox.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await viewer.keyboard.press("Escape");
  await contentRow(viewer, vampId).locator('[data-col="name"]').click();
  await viewer.keyboard.press("Space");
  const field = viewer.getByTestId("row-panel").getByTestId("attachments-field");
  await expect(field.getByTestId("attachment")).toHaveCount(1);
  await expect(field.getByRole("button", { name: "+ Add files" })).toHaveCount(0);
  await expect(field.getByRole("button", { name: "Remove a.png" })).toHaveCount(0);

  const { page: commenter } = await addMember(browser, page, showId, "commenter");
  pages.push(commenter);
  const own = recordId();
  const created = await commenter.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "create", table: "notes", id: own, fields: { body: "mine" } }],
    },
  });
  expect(created.status()).toBe(200);
  expect((await reserve(commenter, "notes", own)).status()).toBe(200);
  const adminNote = (await snap(page, showId)).tables.notes.find((n) => n.id !== own);
  expect((await reserve(commenter, "notes", adminNote?.id ?? "")).status()).toBe(403);
  expect((await reserve(commenter, "content", vampId)).status()).toBe(403);
});
