// M4b: the script view (R20) and the calling-script print (R21). Imports the TXT fixtures
// in e2e/fixtures/, places and attaches cues, jumps between grid and script, imports a
// second version, resolves the flagged cues, reads the old version, prints.
//
// Until M4a (data model + anchoring engine) is merged, run against a build with
// VITE_SCRIPT_MOCK=1: the script data then lives in the browser (see
// src/web/features/script/source.ts), so the viewer test copies it to the viewer's
// browser. With the real engine the copy is a no-op.
import path from "node:path";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { addMember, apiCreateShow, apiLogin, recordId, trackErrors, uniqueName } from "./helpers";

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

const fixture = (name: string) => path.join("e2e", "fixtures", name);

async function newPage(browser: Browser, viewport = { width: 1400, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

async function mutate(page: Page, showId: string, ops: unknown[]) {
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
}

interface Seeded {
  c850: string;
  c1420: string;
  c1425: string;
  scene14: string;
}

/** Scenes 8 and 14; cues 8.50 (LX 117), 14.20 and 14.25 (Line), in show order. */
async function seed(page: Page, showId: string): Promise<Seeded> {
  const s = {
    scene8: recordId(),
    scene14: recordId(),
    c850: recordId(),
    c1420: recordId(),
    c1425: recordId(),
  };
  await mutate(page, showId, [
    { op: "create", table: "scenes", id: s.scene8, fields: { number: "8", name: "Rehearsal" } },
    { op: "create", table: "scenes", id: s.scene14, fields: { number: "14", name: "Platform" } },
    {
      op: "create",
      table: "cues",
      id: s.c850,
      fields: {
        scene_id: s.scene8,
        number: "8.50",
        description: "Steam wash",
        trigger_type: "LX",
        trigger_value: "117",
        lx_cue: "117",
      },
    },
    {
      op: "create",
      table: "cues",
      id: s.c1420,
      fields: {
        scene_id: s.scene14,
        number: "14.20",
        description: "Band girls montage",
        trigger_type: "Line",
        trigger_value: "Sweet Sue needs a sax and a bass",
      },
    },
    {
      op: "create",
      table: "cues",
      id: s.c1425,
      fields: { scene_id: s.scene14, number: "14.25", description: "Tickets", status: "Cued" },
    },
  ]);
  return s;
}

/** Selects `needle` in the first block containing it under `root` and releases the mouse. */
async function selectText(page: Page, needle: string, root = '[data-testid="script-reader"]') {
  await page.evaluate(
    ({ needle, root }) => {
      const container = document.querySelector(root);
      if (!container) throw new Error(`no ${root}`);
      const el = Array.from(container.querySelectorAll("[data-block] [data-text]")).find((b) =>
        (b.textContent ?? "").includes(needle),
      );
      if (!el) throw new Error(`no block with "${needle}"`);
      const start = (el.textContent ?? "").indexOf(needle);
      const end = start + needle.length;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pos = 0;
      let sNode: Node | null = null;
      let sOff = 0;
      let eNode: Node | null = null;
      let eOff = 0;
      while (walker.nextNode()) {
        const n = walker.currentNode;
        const len = n.textContent?.length ?? 0;
        if (!sNode && start < pos + len) {
          sNode = n;
          sOff = start - pos;
        }
        if (!eNode && end <= pos + len) {
          eNode = n;
          eOff = end - pos;
        }
        pos += len;
      }
      if (!sNode || !eNode) throw new Error("text nodes not found");
      const r = document.createRange();
      r.setStart(sNode, sOff);
      r.setEnd(eNode, eOff);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { needle, root },
  );
}

function marker(page: Page, cueId: string): Locator {
  return page.locator(`[data-testid="script-marker"][data-cue="${cueId}"]`);
}

async function importScript(page: Page, file: string, label: string) {
  await page.getByTestId("script-file-input").setInputFiles(fixture(file));
  await expect(page.getByTestId("import-preview")).toContainText("3 pages");
  await page.getByLabel("Version label").fill(label);
  await page.getByRole("button", { name: "Import", exact: true }).click();
}

async function attachBySelection(page: Page, needle: string, cueNumber: string) {
  await selectText(page, needle);
  const pop = page.getByTestId("place-popover");
  await pop.getByRole("button", { name: "Attach existing cue" }).click();
  await page.getByRole("combobox", { name: "Find a cue" }).fill(cueNumber);
  await expect(
    page.getByRole("option", { name: new RegExp(`^${cueNumber.replace(".", "\\.")}`) }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(pop).toBeHidden();
}

/** The mock keeps script data in the browser: give it to another browser (no-op when live). */
async function shareMockScript(from: Page, to: Page, showId: string) {
  const key = `cuesheet.scriptmock.${showId}`;
  const value = await from.evaluate((k) => localStorage.getItem(k), key);
  if (value) {
    await to.context().addInitScript(
      ([k, v]) => {
        localStorage.setItem(k as string, v as string);
      },
      [key, value],
    );
  }
}

async function cueOrder(page: Page, showId: string) {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  const snap = (await res.json()) as {
    tables: {
      cues: {
        id: string;
        number: string | null;
        page: string | null;
        scene_id: string | null;
        status: string | null;
        trigger_type: string | null;
        trigger_value: string | null;
      }[];
    };
  };
  return snap.tables.cues;
}

test("script: import, place and attach cues, grid ↔ script, new version, resolve, versions, print", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Script"));
  const ids = await seed(page, showId);

  // --- Import v1 ---
  await page.goto(`/shows/${showId}/script`);
  await expect(page.getByTestId("script-empty")).toBeVisible();
  await importScript(page, "script-v1.txt", "Rehearsal draft");
  await expect(page.getByTestId("script-page")).toHaveCount(3);
  await expect(page.getByTestId("import-report")).toContainText("3 pages");
  await expect(page.getByTestId("current-page")).toHaveText("12");
  await expect(page.locator('[data-kind="character"]').first()).toHaveCSS(
    "font-variant-caps",
    "small-caps",
  );

  // --- Attach 14.20 and 14.25 to their lines ---
  await attachBySelection(page, "Sweet Sue needs a sax and a bass", "14.20");
  await expect(marker(page, ids.c1420)).toContainText("Q 14.20");
  await expect(marker(page, ids.c1420)).toContainText("LINE");
  await attachBySelection(page, "Try not to wake the drummer", "14.25");
  await expect(marker(page, ids.c1425)).toBeVisible();

  // --- New cue on a line between them: 14.22 suggested, LINE trigger ---
  await selectText(page, "Josephine, tenor sax");
  const pop = page.getByTestId("place-popover");
  await pop.getByRole("button", { name: "New cue on this line" }).click();
  await expect(pop.getByLabel("Cue number")).toHaveValue("14.22");
  await expect(pop.getByLabel("Trigger value")).toHaveValue("Josephine, tenor sax");
  await pop.getByLabel("Description").fill("Sax solo glow");
  await pop.getByRole("button", { name: "Create cue" }).click();
  await expect(pop).toBeHidden();
  const m1422 = page.locator('[data-testid="script-marker"]', { hasText: "Q 14.22" });
  await expect(m1422).toContainText("LINE");
  await expect(m1422).toContainText("Josephine, tenor sax");
  await expect(page.locator("[data-quote]", { hasText: "Josephine, tenor sax" })).toBeVisible();

  // --- Attach 8.50 by clicking the margin beside BIENSTOCK: an LX marker ---
  const bienstock = page.locator('[data-kind="character"]', { hasText: "BIENSTOCK" });
  const box = await bienstock.boundingBox();
  const margin = await page.locator('[data-page="2"] [data-testid="script-margin"]').boundingBox();
  if (!box || !margin) throw new Error("no layout");
  await page.mouse.click(margin.x + margin.width - 20, box.y + box.height / 2);
  await expect(pop).toBeVisible();
  await expect(pop.getByLabel("Trigger type")).toHaveValue("LX");
  await pop.getByRole("button", { name: "Attach existing cue" }).click();
  await page.getByRole("combobox", { name: "Find a cue" }).fill("8.50");
  await expect(page.getByRole("option", { name: /^8\.50/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(marker(page, ids.c850)).toContainText("LX 117");
  await expect(marker(page, ids.c850)).toHaveAttribute("data-positional", "true");
  await expect(page.getByTestId("script-marker")).toHaveCount(4);

  // --- The grid: 14.22 in scene order (after 14.20, scene 14) with its page ---
  const cues = await cueOrder(page, showId);
  expect(cues.map((c) => c.number)).toEqual(["8.50", "14.20", "14.22", "14.25"]);
  const c1422 = cues.find((c) => c.number === "14.22");
  expect(c1422).toMatchObject({
    scene_id: ids.scene14,
    page: "13",
    trigger_type: "Line",
    trigger_value: "Josephine, tenor sax",
  });
  expect(cues.find((c) => c.number === "14.25")?.page).toBe("13");
  const id1422 = c1422?.id as string;

  // --- Grid → script: ⌘K "Show in script" and the row menu ---
  await page.goto(`/shows/${showId}/cues?cue=${ids.c1425}`);
  await expect(page.getByRole("gridcell", { name: "14.22" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("combobox").fill("Show in script");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/script\\?cue=${ids.c1425}`));
  await expect(marker(page, ids.c1425)).toHaveAttribute("data-flash", "true");
  await expect(marker(page, ids.c1425)).toBeInViewport();

  // Script → grid ("Show in list" in the marker menu) and back from the grid's row menu.
  await marker(page, id1422)
    .getByRole("button", { name: /More actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Show in list" }).click();
  await expect(page).toHaveURL(new RegExp(`/cues\\?cue=${id1422}`));
  await page.getByRole("gridcell", { name: "14.22" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show in script" }).click();
  await expect(page).toHaveURL(new RegExp(`/script\\?cue=${id1422}`));
  await expect(marker(page, id1422)).toHaveAttribute("data-flash", "true");

  // Clicking a marker opens the cue's panel with its Script tab.
  await marker(page, id1422)
    .getByRole("button", { name: /^Q 14\.22/ })
    .click();
  const panel = page.getByTestId("row-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "Script" }).click();
  await expect(panel.getByTestId("panel-script")).toContainText("Josephine, tenor sax");
  await panel.getByRole("button", { name: "Close panel" }).click();

  // --- Version 2: one line rewritten, one deleted, a paragraph inserted ---
  await page.getByRole("button", { name: "Import new version" }).click();
  await importScript(page, "script-v2.txt", "v2");
  await expect(page.getByTestId("report-counts")).toHaveText(
    "1 matched · 0 moved · 1 changed · 2 missing",
  );
  await expect(page.getByTestId("unplaced-tray")).toContainText("Q 14.25");
  await expect(marker(page, ids.c1420)).toHaveAttribute("data-state", "changed");
  await expect(marker(page, ids.c1420).getByTestId("marker-warning")).toBeVisible();

  // --- Resolve: Accept 14.20, Cut 8.50, Place 14.25 ---
  await page.getByRole("button", { name: "Resolve 3 cues" }).click();
  const resolve = page.getByTestId("resolve-screen");
  await expect(resolve.getByTestId("resolve-item")).toHaveCount(3);
  await expect(resolve.getByRole("heading", { name: /Q 14\.20/ })).toBeVisible();
  await expect(resolve.getByTestId("resolve-old-text")).toContainText("a sax and a bass");
  await expect(resolve.getByTestId("resolve-new-text").locator("[data-quote]")).toHaveText(
    "Sweet Sue needs a saxophone and a bass",
  );
  await resolve.getByRole("button", { name: "Accept" }).click();
  await expect(resolve.getByRole("heading", { name: /Q 8\.50/ })).toBeVisible();
  await resolve.getByRole("button", { name: "Cut" }).click();
  await expect(resolve.getByRole("heading", { name: /Q 14\.25/ })).toBeVisible();
  await resolve.getByRole("button", { name: "Place", exact: true }).click();
  await selectText(page, "Whatever you are, you're hired.", '[data-testid="resolve-new-text"]');
  await resolve.getByRole("button", { name: "Place Q 14.25 here" }).click();
  await expect(resolve.getByTestId("resolve-done")).toBeVisible();
  await resolve.getByRole("button", { name: "Back to the script" }).click();

  await expect(page.getByTestId("unplaced-tray")).toHaveCount(0);
  await expect(marker(page, ids.c1420)).toHaveAttribute("data-state", "manual");
  await expect(marker(page, ids.c1425)).toHaveAttribute("data-state", "manual");
  await expect(marker(page, ids.c850)).toHaveCount(0);
  const after = await cueOrder(page, showId);
  expect(after.find((c) => c.id === ids.c850)?.status).toBe("Cut");

  // --- Version switcher: v1 read-only with its own markers ---
  await page.getByLabel("Script version").selectOption({ label: "Rehearsal draft" });
  await expect(page.getByTestId("script-readonly")).toBeVisible();
  await expect(marker(page, ids.c850)).toContainText("LX 117");
  await expect(page.getByTestId("script-marker")).toHaveCount(4);
  await selectText(page, "Daphne. Bass.");
  await page.waitForTimeout(200);
  await expect(page.getByTestId("place-popover")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to current" }).click();
  await expect(page.getByTestId("script-readonly")).toHaveCount(0);

  // --- Print: light, with markers ---
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Print calling script" }).click();
  await expect(page.getByTestId("print-script")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("print-version")).toHaveText("v2");
  await expect(page.getByTestId("print-page")).toHaveCount(3);
  await expect(page.getByTestId("print-marker")).toHaveCount(3);
  await expect(page.getByTestId("print-marker").first()).toContainText("Q 14.20");
  // Only Cued cues (the filter bar's ?filter=).
  await page.goto(`/shows/${showId}/script/print?filter=${encodeURIComponent("status=Cued")}`);
  await expect(page.getByTestId("print-marker")).toHaveCount(1);
  await expect(page.getByTestId("print-marker")).toContainText("Q 14.25");
  await page.getByRole("link", { name: "← Back" }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // --- Grid Print view ---
  await page.goto(`/shows/${showId}/cues`);
  await page.getByTestId("print-view-link").click();
  await expect(page.getByTestId("print-view")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("print-group")).toHaveCount(2);
  await expect(page.getByTestId("print-group").nth(1)).toContainText("14.22");
});

test("script: viewers read without placing; phones get badges", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Script roles"));
  const ids = await seed(page, showId);
  await page.goto(`/shows/${showId}/script`);
  await importScript(page, "script-v1.txt", "v1");
  await attachBySelection(page, "Sweet Sue needs a sax and a bass", "14.20");

  const { page: viewer } = await addMember(browser, page, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  await shareMockScript(page, viewer, showId);
  await viewer.goto(`/shows/${showId}/script?cue=${ids.c1420}`);
  await expect(marker(viewer, ids.c1420)).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Import new version" })).toHaveCount(0);
  await expect(viewer.getByTestId("script-margin").first()).not.toHaveAttribute(
    "data-can-place",
    "true",
  );
  await selectText(viewer, "Daphne. Bass.");
  await viewer.waitForTimeout(200);
  await expect(viewer.getByTestId("place-popover")).toHaveCount(0);
  await expect(
    marker(viewer, ids.c1420).getByRole("button", { name: /More actions/ }),
  ).toBeVisible();

  // 390 px: one column, markers as badges that expand on tap; nothing wider than the screen.
  const phone = await newPage(browser, { width: 390, height: 844 });
  await shareMockScript(page, phone, showId);
  await phone.goto(`/shows/${showId}/script`);
  await expect(phone.getByTestId("script-page").first()).toBeVisible();
  await expect(phone.getByTestId("script-margin")).toHaveCount(0);
  const badge = marker(phone, ids.c1420);
  await expect(badge).toHaveText(/Q 14\.20/);
  await badge.click();
  await expect(phone.getByTestId("marker-card")).toContainText("LINE");
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await phone.getByTestId("marker-card").getByRole("button", { name: "Open" }).click();
  await expect(phone.getByTestId("row-panel")).toBeVisible();
});

test("script: j/k pages, / find and g go to page", async ({ browser }) => {
  const page = await newPage(browser, { width: 1200, height: 500 });
  const showId = await apiCreateShow(page, uniqueName("Script keys"));
  await page.goto(`/shows/${showId}/script`);
  await importScript(page, "script-v1.txt", "v1");
  await expect(page.getByTestId("current-page")).toHaveText("12");
  await page.getByTestId("script-reader").click({ position: { x: 5, y: 60 } });
  await page.keyboard.press("j");
  await expect(page.getByTestId("current-page")).toHaveText("13");
  await page.keyboard.press("k");
  await expect(page.getByTestId("current-page")).toHaveText("12");
  await page.keyboard.press("g");
  await page.getByLabel("Go to page").fill("14");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("current-page")).toHaveText("14");
  await page.keyboard.press("/");
  await page.getByLabel("Find in script").fill("corkscrew");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 2");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("2 of 2");
  await expect(page.locator("[data-block][data-highlight]")).toContainText("other purse");
});
