// A tab still running the previous build after a deploy (src/web/lib/staleBuild.ts): its
// lazy chunks are gone from the server. The server answers 404 for them (not the app
// shell), and the app reloads once onto the new build instead of showing React Router's
// raw "Unexpected Application Error"; it waits for unsent edits first, and if the new build
// fails too it asks for a reload rather than looping. The missing chunk is simulated by
// answering the PDF reader's chunk with a 404.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  apiCreateShow,
  apiLogin,
  recordId,
  trackErrors,
  uniqueName,
  waitForShowReady,
} from "./helpers";

const CHUNK = "**/assets/PdfReader-*.js";

let errors: string[] = [];
const pages: Page[] = [];

test.beforeEach(() => {
  errors = [];
  pages.length = 0;
});

test.afterEach(async () => {
  // The simulated 404 and the failed import it causes are expected; nothing else is.
  const unexpected = errors.filter(
    (e) =>
      !/status of 404|dynamically imported module|PdfReader-|Failed to load module script/.test(e),
  );
  expect(unexpected, "console errors").toEqual([]);
  for (const p of pages) await p.context().close();
});

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  page.drawText("1", { x: 530, y: 750, size: 10, font });
  page.drawText("JOE", { x: 280, y: 690, size: 12, font });
  page.drawText("Keep your head down and your case up.", { x: 150, y: 676, size: 12, font });
  return Buffer.from(await doc.save());
}

/** A show with a PDF script (so its Script tab needs the lazy PDF reader chunk). */
async function pdfShow(browser: Browser): Promise<{ page: Page; showId: string; cueId: string }> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const setup = await context.newPage();
  pages.push(setup);
  await apiLogin(setup);
  const showId = await apiCreateShow(setup, uniqueName("Stale build"));
  const cueId = recordId();
  const res = await setup.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "create", table: "cues", id: cueId, fields: { number: "1" } }],
    },
  });
  expect(res.status()).toBe(200);
  await setup.goto(`/shows/${showId}/script`);
  await setup.getByTestId("script-file-input").setInputFiles({
    name: "script.pdf",
    mimeType: "application/pdf",
    buffer: await onePagePdf(),
  });
  await expect(setup.getByTestId("import-preview")).toContainText("1 page", { timeout: 20_000 });
  await setup.getByLabel("Version label").fill("v1");
  await setup.getByRole("button", { name: "Import", exact: true }).click();
  await expect(setup.getByTestId("pdf-view")).toBeVisible();
  await setup.close();
  // A fresh document: the reader chunk isn't loaded in it yet.
  const page = await context.newPage();
  trackErrors(page, errors);
  return { page, showId, cueId };
}

/** Opens the show's cue list and marks the document, to tell whether it was reloaded. */
async function openCues(page: Page, showId: string) {
  await page.goto(`/shows/${showId}/cues`);
  await waitForShowReady(page);
  await page.evaluate(() => {
    (window as unknown as { __oldDocument: boolean }).__oldDocument = true;
  });
}

const reloaded = (page: Page) =>
  page.evaluate(() => !(window as unknown as { __oldDocument?: boolean }).__oldDocument);

test("a missing build file is a 404, app routes still get the app", async ({ page }) => {
  const missing = await page.request.get("/assets/does-not-exist.js");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"] ?? "").not.toContain("text/html");
  const route = await page.request.get("/shows/x/script");
  expect(route.status()).toBe(200);
  expect(route.headers()["content-type"]).toContain("text/html");
  expect(route.headers()["content-security-policy"]).toContain("default-src 'self'");
});

test("a lazy chunk gone after a deploy: the page reloads once and works", async ({ browser }) => {
  test.setTimeout(90_000);
  const { page, showId } = await pdfShow(browser);
  await page.route(CHUNK, (r) => r.fulfill({ status: 404, body: "Not found" }), { times: 1 });
  await openCues(page, showId);
  await page.getByRole("link", { name: "Script", exact: true }).click();
  await expect(page.getByTestId("pdf-view")).toBeVisible();
  expect(await reloaded(page)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/shows/${showId}/script`));
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);
  await expect(page.getByTestId("stale-build")).toHaveCount(0);
});

test("the reload waits for an unsent edit, which is saved", async ({ browser }) => {
  test.setTimeout(90_000);
  const { page, showId, cueId } = await pdfShow(browser);
  await page.route(CHUNK, (r) => r.fulfill({ status: 404, body: "Not found" }), { times: 1 });
  // Hold the edit's request until the test lets it go.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let sent = false;
  await page.route(`**/api/shows/${showId}/mutate`, async (r) => {
    sent = true;
    await held;
    await r.continue();
  });
  await openCues(page, showId);
  const row = page
    .getByRole("grid", { name: "Cue list" })
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText("1", { exact: true }) });
  await row.locator('[data-col="description"]').click();
  await page.keyboard.type("Saved before the reload");
  await page.keyboard.press("Enter");
  await expect.poll(() => sent).toBe(true);

  await page.getByRole("link", { name: "Script", exact: true }).click();
  const banner = page.getByTestId("stale-build");
  await expect(banner).toHaveAttribute("data-state", "waiting");
  await expect(banner).toContainText("once your edits are saved");
  expect(await reloaded(page)).toBe(false);
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);

  release();
  await expect(page.getByTestId("pdf-view")).toBeVisible();
  expect(await reloaded(page)).toBe(true);
  const snap = await page.request.get(`/api/shows/${showId}/snapshot`);
  const { tables } = (await snap.json()) as {
    tables: { cues: { id: string; description: string | null }[] };
  };
  expect(tables.cues.find((c) => c.id === cueId)?.description).toBe("Saved before the reload");
});

test("if the new build fails too: one reload, then a reload prompt, no loop", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { page, showId } = await pdfShow(browser);
  await page.route(CHUNK, (r) => r.fulfill({ status: 404, body: "Not found" }));
  let loads = 0;
  page.on("load", () => {
    loads++;
  });
  await openCues(page, showId);
  await page.getByRole("link", { name: "Script", exact: true }).click();
  const banner = page.getByTestId("stale-build");
  await expect(banner).toHaveAttribute("data-state", "prompt");
  await expect(banner).toContainText("Cuesheet was updated. Reload the page");
  expect(await reloaded(page)).toBe(true);
  await expect.poll(() => loads).toBe(2); // the cue list, then the one automatic reload
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);
  await expect(page.getByTestId("route-error")).toHaveAttribute("data-kind", "stale");
  // The rest of the show still works: the header and the other tabs.
  await page.getByRole("link", { name: "Cues", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();

  await page.getByRole("link", { name: "Script", exact: true }).click();
  await expect(page.getByTestId("route-error")).toHaveAttribute("data-kind", "stale");
  await expect.poll(() => loads).toBe(2);

  // The button reloads (the user's choice, so the guard doesn't apply).
  await page.unroute(CHUNK);
  await banner.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("pdf-view")).toBeVisible();
  await expect.poll(() => loads).toBe(3);
});
