// M5b: read-only share links (R23). The owner makes a link in Show settings → Sharing;
// someone with no account opens it in a fresh browser: the cue list's view, read-only, no
// tabs; an owner's edit arrives live; a row opens read-only; revoking closes it (410 page).
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  apiCreateShow,
  apiLogin,
  importExamples,
  openShow,
  snapshot,
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
  // Resolving a revoked or unknown link answers 410 / 404, which Chromium logs.
  const expected = (e: string) => e.includes("/api/share/") && /status of 4(04|10)/.test(e);
  expect(
    errors.filter((e) => !expected(e)),
    "console errors",
  ).toEqual([]);
  for (const p of pages) await p.context().close();
});

async function newPage(browser: Browser, viewport = { width: 1300, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  return page;
}

/** Show settings → Sharing → a link for `target` (an option's label); returns its URL. */
async function createLink(page: Page, target: string, opts: { print?: boolean } = {}) {
  await page.getByRole("button", { name: "Show settings" }).click();
  const sharing = page.getByTestId("sharing");
  await sharing.getByLabel("What to share").selectOption({ label: target });
  await expect(sharing.getByTestId("share-scope-note")).toContainText(
    target.includes(" · ") ? "not just this view's filtered rows" : "the chosen layout",
  );
  if (opts.print) await sharing.getByText("As a print layout").click();
  await sharing.getByLabel("Label").fill("For the SM");
  await sharing.getByRole("button", { name: "Create link" }).click();
  const url = (await page.getByTestId("share-new-link").locator("code").textContent()) ?? "";
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{40,}$/);
  return url;
}

test("share a view: read-only, live, row details, revoke → 410", async ({ browser }) => {
  const owner = await newPage(browser);
  await apiLogin(owner);
  const showId = await apiCreateShow(owner, uniqueName("Shared"));
  await importExamples(owner, showId);
  await openShow(owner, showId, "/cues");
  const url = await createLink(owner, "Cues · All cues");
  await expect(owner.getByTestId("share-links").locator("li")).toHaveCount(1);
  await expect(owner.getByTestId("share-links")).toContainText("For the SM");

  // A browser with no account.
  const viewer = await newPage(browser);
  await viewer.goto(url);
  const share = viewer.getByTestId("share-page");
  await expect(share).toHaveAttribute("data-store-status", "ready");
  await expect(share).toHaveAttribute("data-kind", "view");
  await expect(viewer.getByTestId("print-row").first()).toBeVisible();
  // Just the view: no tabs, no Show settings, no Back; live; the theme toggle is there.
  await expect(viewer.getByRole("navigation", { name: "Show" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Show settings" })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "← Back" })).toHaveCount(0);
  await expect(viewer.getByTestId("presence")).toHaveAttribute("data-status", "connected");
  await expect(viewer.getByTestId("presence-count")).toHaveCount(0);
  await expect(viewer.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  const html = viewer.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await viewer.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");

  // The owner's presence names the visitor as a guest (the visitor sees no names).
  await owner.keyboard.press("Escape");
  await expect(owner.getByTestId("presence")).toHaveAttribute("data-clients", "2");
  await owner.getByRole("button", { name: /who's here/ }).click();
  const list = owner.getByTestId("presence-list");
  await expect(list).toContainText("Guest (read-only)");
  await expect(list).toContainText("Admin");
  await expect(viewer.getByTestId("presence-list")).toHaveCount(0);

  // The owner edits a cue; the viewer sees it without reloading.
  const cues = (await snapshot(owner, showId)).tables.cues.filter((c) => !c.is_section);
  const first = cues[0];
  if (!first) throw new Error("no cues");
  const text = uniqueName("Blackout, live");
  const res = await owner.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "update", table: "cues", id: first.id, fields: { description: text } }],
    },
  });
  expect(res.status()).toBe(200);
  await expect(viewer.getByRole("cell", { name: text })).toBeVisible();

  // A row opens read-only.
  const row = viewer.getByTestId("print-row").filter({ hasText: text });
  await row.getByTestId("share-open-row").click();
  const details = viewer.getByTestId("share-row-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText(text);
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await viewer.keyboard.press("Escape");
  await expect(details).toHaveCount(0);

  // The viewer can't write, even through the API.
  const write = await viewer.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "x", ops: [] },
    headers: { Origin: new URL(url).origin },
  });
  expect(write.status()).toBe(403);

  // Revoke: the open page shows that the link is gone.
  await owner.getByRole("button", { name: "Show settings" }).click();
  owner.once("dialog", (d) => void d.accept());
  await owner.getByRole("button", { name: "Revoke For the SM" }).click();
  await expect(owner.getByTestId("share-links").locator("li")).toHaveAttribute(
    "data-status",
    "revoked",
  );
  await expect(viewer.getByTestId("share-gone")).toHaveAttribute("data-status", "410");
  await viewer.goto(url);
  await expect(viewer.getByTestId("share-gone")).toContainText("revoked or has expired");
});

test("share a print layout: SM cue sheet, light, without signing in", async ({ browser }) => {
  const owner = await newPage(browser);
  await apiLogin(owner);
  const showId = await apiCreateShow(owner, uniqueName("Shared print"));
  await importExamples(owner, showId);
  await openShow(owner, showId, "/cues");
  const url = await createLink(owner, "SM cue sheet");

  const viewer = await newPage(browser, { width: 390, height: 844 });
  await viewer.goto(url);
  await expect(viewer.getByTestId("share-page")).toHaveAttribute("data-kind", "print");
  await expect(viewer.getByTestId("print-view")).toBeVisible();
  await expect(viewer.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    viewer.getByRole("columnheader", { name: "SM call / trigger" }).first(),
  ).toBeVisible();
  await expect(viewer.getByTestId("share-open-row")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Print / Save as PDF" })).toBeVisible();
  const overflow = () =>
    viewer.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBeLessThanOrEqual(0);

  // A live view link fits the phone too (wide tables scroll inside their own box).
  await owner.keyboard.press("Escape");
  const live = await createLink(owner, "Cues · All cues");
  await viewer.goto(live);
  await expect(viewer.getByTestId("share-open-row").first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test("an unknown share link says so", async ({ browser }) => {
  const viewer = await newPage(browser);
  await viewer.goto("/s/this-is-not-a-real-token-0000000000000000000");
  await expect(viewer.getByTestId("share-gone")).toHaveAttribute("data-status", "404");
});
