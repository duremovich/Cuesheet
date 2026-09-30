// M2b: the notes panel, the editable row panel with history, tech mode and the phone
// quick-add page, on the Some Like It Hot example imported into a fresh show per test.
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  addMember,
  apiCreateShow,
  apiLogin,
  importExamples,
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

async function newPage(browser: Browser, viewport = { width: 1400, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

async function exampleShow(browser: Browser) {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Some Like It Hot"));
  await importExamples(page, showId);
  return { page, showId };
}

interface Snap {
  tables: {
    cues: { id: string; number: string | null }[];
    content: { id: string; name: string | null }[];
    notes: {
      id: string;
      body: string | null;
      type: string[];
      priority: string | null;
      status: string | null;
      session: string | null;
      content_id: string | null;
    }[];
  };
  joins: { noteCues: Record<string, string[]>; cueContent: Record<string, string[]> };
}

async function snap(page: Page, showId: string): Promise<Snap> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Snap;
}

async function cueId(page: Page, showId: string, number: string) {
  const c = (await snap(page, showId)).tables.cues.find((x) => x.number === number);
  if (!c) throw new Error(`no cue ${number}`);
  return c.id;
}

/** The note with this body (waits for it to reach the server). */
async function noteByBody(page: Page, showId: string, body: string) {
  let found: Snap["tables"]["notes"][number] | undefined;
  let s: Snap | undefined;
  await expect
    .poll(async () => {
      s = await snap(page, showId);
      found = s.tables.notes.find((n) => n.body === body);
      return !!found;
    })
    .toBe(true);
  const note = found as Snap["tables"]["notes"][number];
  const cues = (s as Snap).joins.noteCues[note.id] ?? [];
  const numbers = cues.map((id) => (s as Snap).tables.cues.find((c) => c.id === id)?.number);
  return { ...note, cueNumbers: numbers };
}

const cueGrid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const rowByCue = (page: Page, cue: string) =>
  cueGrid(page)
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });

/** Opens the cue list at a cue and its row panel. */
async function openPanel(page: Page, showId: string, number: string) {
  const id = await cueId(page, showId, number);
  await page.goto(`/shows/${showId}/cues?cue=${id}`);
  const cell = rowByCue(page, number).locator('[data-col="number"]');
  await expect(cell).toHaveAttribute("data-active", "true");
  await cell.click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(`Cue ${number}`);
  return panel;
}

test("notes panel on a cue: add a typed, prioritised note; cycle it to Done", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  const panel = await openPanel(page, showId, "14.20");
  await panel.getByRole("tab", { name: /Notes/ }).click();
  const notes = panel.getByTestId("notes-panel");
  // The example's notes on 14.20 are listed.
  await expect(notes.getByTestId("note").first()).toBeVisible();

  const body = uniqueName("add grunge overlay");
  const compose = notes.getByRole("textbox", { name: "New note" });
  await notes.getByRole("button", { name: "Content", exact: true }).click();
  await compose.click();
  await compose.fill(body);
  await page.keyboard.press("Alt+Digit3");
  await expect(notes.getByRole("combobox", { name: "Priority" })).toHaveValue("3");
  await expect(notes.getByTestId("compose-target")).toHaveText("→ Cue 14.20");
  await page.keyboard.press("Enter");
  await expect(compose).toHaveValue("");

  const card = notes.getByTestId("note").filter({ hasText: body });
  await expect(card).toContainText("Content");
  await expect(card).toContainText("P3");
  // Open notes come first, newest first: ours is at the top.
  await expect(notes.getByTestId("note").first()).toContainText(body);

  const saved = await noteByBody(page, showId, body);
  expect(saved).toMatchObject({ type: ["Content"], priority: "3", status: "Open" });
  expect(saved.cueNumbers).toEqual(["14.20"]);
  // Linked to the cue's only content item too.
  const content = (await snap(page, showId)).tables.content.find((c) => c.id === saved.content_id);
  expect(content?.name).toBe("105-001-VAMP");

  // The Notes tab shows it with its links, in the Open group.
  await page.goto(`/shows/${showId}/notes?note=${saved.id}`);
  const notesGrid = page.getByRole("grid", { name: "Notes" });
  const row = notesGrid.getByTestId("grid-row").filter({ hasText: body });
  await expect(row.locator('[data-col="cues"]')).toHaveText("14.20");
  await expect(row.locator('[data-col="content"]')).toHaveText("105-001-VAMP");
  const groupIndex = async (title: string) =>
    Number(
      await notesGrid
        .getByTestId("group-header")
        .filter({ hasText: title })
        .first()
        .getAttribute("aria-rowindex"),
    );
  const rowIndex = async () => Number(await row.getAttribute("aria-rowindex"));
  expect(await rowIndex()).toBeGreaterThan(await groupIndex("Open"));
  expect(await rowIndex()).toBeLessThan(await groupIndex("In progress"));

  // Cycle the status from the cue's notes panel: Open → In progress → Done.
  const panel2 = await openPanel(page, showId, "14.20");
  await panel2.getByRole("tab", { name: /Notes/ }).click();
  const card2 = panel2.getByTestId("note").filter({ hasText: body });
  await card2.getByRole("button", { name: /^Status: Open/ }).click();
  await card2.getByRole("button", { name: /^Status: In progress/ }).click();
  await expect(card2.getByRole("button", { name: /^Status: Done/ })).toBeVisible();
  // Done notes go below the open ones (newest Done first).
  const open = await panel2.locator('[data-testid="note"]:not([data-status="Done"])').count();
  await expect(panel2.getByTestId("note").nth(open)).toContainText(body);
  await expect.poll(async () => (await noteByBody(page, showId, body)).status).toBe("Done");

  await page.goto(`/shows/${showId}/notes?note=${saved.id}`);
  await expect(row).toBeVisible(); // the Done group opens to show it
  expect(await rowIndex()).toBeGreaterThan(await groupIndex("Done"));
});

test("tech mode: step with ↓, prefixes, general notes, the session label", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  const other = await newPage(browser);
  await other.goto(`/shows/${showId}/cues`);
  await expect(cueGrid(other)).toBeVisible();

  // T in the cue list opens tech mode at the active cue.
  await page.goto(`/shows/${showId}/cues`);
  const first = cueGrid(page).getByTestId("grid-row").first().locator('[data-col="number"]');
  await first.click();
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/tech\?cue=/);
  const tech = page.getByTestId("tech-mode");
  const compose = tech.getByRole("textbox", { name: "Tech note" });
  await expect(compose).toBeFocused();

  const numbers = await tech
    .getByTestId("tech-cue")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-cue-number")));
  const current = await tech.locator('[data-testid="tech-cue"][aria-current="true"]');
  await expect(current).toHaveAttribute("data-cue-number", numbers[0] as string);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(current).toHaveAttribute("data-cue-number", numbers[2] as string);
  await expect(tech.getByTestId("tech-current")).toContainText(`Cue ${numbers[2]}`);
  const thirdId = await cueId(page, showId, numbers[2] as string);
  await expect(page).toHaveURL(new RegExp(`cue=${thirdId}`));

  // Session: set once; stamped on new notes; everyone sees it.
  const session = tech.getByRole("combobox", { name: "Session" });
  await session.fill("Tech 2");
  await session.press("Enter");
  await expect(other.getByRole("combobox", { name: "Session" })).toHaveValue("Tech 2");

  const onThird = uniqueName("strumming effect timing");
  await compose.click();
  await page.keyboard.type(onThird);
  await page.keyboard.press("Enter");
  await expect(compose).toHaveValue("");
  await expect(compose).toBeFocused();
  const n1 = await noteByBody(page, showId, onThird);
  expect(n1.cueNumbers).toEqual([numbers[2]]);
  expect(n1.session).toBe("Tech 2");
  await expect(tech.getByTestId("note").filter({ hasText: onThird })).toBeVisible();

  // "8.5 …" goes to cue 8.50; the current cue stays.
  const fade = uniqueName("fix fade");
  await page.keyboard.type(`8.5 ${fade}`);
  await expect(tech.getByTestId("compose-target")).toHaveText("→ Cue 8.50");
  await page.keyboard.press("Enter");
  const n2 = await noteByBody(page, showId, fade);
  expect(n2.cueNumbers).toEqual(["8.50"]);
  await expect(current).toHaveAttribute("data-cue-number", numbers[2] as string);

  // "* …" is a general note.
  const general = uniqueName("order more haze");
  await page.keyboard.type(`* ${general}`);
  await page.keyboard.press("Enter");
  const n3 = await noteByBody(page, showId, general);
  expect(n3.cueNumbers).toEqual([]);
  expect(n3.content_id).toBeNull();
  expect(n3.session).toBe("Tech 2");

  // ⌘G jumps to a typed cue number; Space moves on when the box is empty.
  await page.keyboard.press("ControlOrMeta+g");
  await tech.getByRole("textbox", { name: "Go to cue" }).fill("14.2");
  await page.keyboard.press("Enter");
  await expect(current).toHaveAttribute("data-cue-number", "14.20");
  await expect(compose).toBeFocused();
  await page.keyboard.press("Space");
  await expect(current).toHaveAttribute("data-cue-number", "14.25");
  await expect(compose).toHaveValue("");

  // The cue list link keeps the current cue (?cue= is shared).
  await tech.getByRole("link", { name: "Cue list" }).click();
  await expect(page).toHaveURL(/\/cues\?cue=/);
  await expect(rowByCue(page, "14.25").locator('[data-col="number"]')).toHaveAttribute(
    "data-active",
    "true",
  );
});

test("row panel: edit a field, see it in the grid and in History", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  const panel = await openPanel(page, showId, "14.25");
  const desc = panel.getByRole("textbox", { name: "Description" });
  const text = uniqueName("lights flash twice");
  await desc.fill(text);
  await desc.press("Enter");
  await expect(rowByCue(page, "14.25").locator('[data-col="description"]')).toHaveText(text);

  // Select via the same picker as the grid.
  await panel.getByRole("button", { name: "Set Status" }).click();
  await page.getByRole("combobox", { name: "Status: search" }).fill("Cued");
  await page.keyboard.press("Enter");
  await expect(rowByCue(page, "14.25").locator('[data-col="status"]')).toHaveText("Cued");

  const me = (await page.getByTestId("current-user").textContent()) ?? "";
  await panel.getByRole("tab", { name: "History" }).click();
  const history = panel.getByTestId("history");
  await expect(history.getByRole("listitem").first()).toContainText(`${me} changed Status`);
  await expect(
    history.getByRole("listitem").filter({ hasText: "changed Description" }),
  ).toContainText(text);
  await expect(history).toContainText(`${me} created this`);

  // Content tab: linked content as cards.
  await panel.getByRole("tab", { name: /Content/ }).click();
  await expect(panel.getByTestId("content-card")).toHaveCount(0);
  const panel2 = await openPanel(page, showId, "14.20");
  await panel2.getByRole("tab", { name: /Content/ }).click();
  await expect(panel2.getByTestId("content-card")).toContainText("105-001-VAMP");

  // Escape leaves a field first, then closes the panel.
  await panel2.getByRole("tab", { name: "Fields" }).click();
  await panel2.getByRole("textbox", { name: "Page" }).click();
  await page.keyboard.press("Escape");
  await expect(panel2).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel2).toHaveCount(0);
});

test("quick-add at 390px: pick a cue, save, the cue stays picked", async ({ browser }) => {
  const admin = await newPage(browser);
  const showId = await apiCreateShow(admin, uniqueName("Quick"));
  await importExamples(admin, showId);
  const page = await newPage(browser, { width: 390, height: 844 });
  await page.goto(`/shows/${showId}/cues`);
  await page.getByRole("link", { name: "Quick add a note" }).click();
  await expect(page).toHaveURL(/\/quick/);

  const quick = page.getByTestId("quick-add");
  await quick.getByRole("searchbox", { name: "Find a cue" }).fill("14.2");
  await quick.getByRole("button", { name: /^14\.20/ }).click();
  await expect(quick.getByTestId("quick-picked")).toContainText("Cue 14.20");
  await expect(quick.getByRole("button", { name: "Add a photo" })).toHaveAttribute(
    "title",
    "Attachments arrive in M3",
  );

  const body = uniqueName("phone note");
  await quick.getByRole("textbox", { name: "Quick note" }).fill(body);
  await quick.getByRole("button", { name: "Director" }).click();
  await quick.getByRole("button", { name: "Add note" }).click();
  await expect(quick.getByRole("status")).toHaveText("Saved to Cue 14.20");
  await expect(quick.getByTestId("quick-picked")).toContainText("Cue 14.20");
  const saved = await noteByBody(page, showId, body);
  expect(saved.cueNumbers).toEqual(["14.20"]);
  expect(saved.type).toEqual(["Director"]);

  // The picked cue is remembered as recent.
  await quick.getByTestId("quick-picked").click();
  await expect(quick.getByText("Recent")).toBeVisible();
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client);

  // The row panel is a bottom sheet with a handle that pulls it to full height.
  await page.goto(`/shows/${showId}/cues`);
  await cueGrid(page).getByTestId("grid-row").first().locator('[data-col="number"]').click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  const h1 = (await panel.boundingBox())?.height ?? 0;
  await panel.getByRole("button", { name: "Expand panel" }).click();
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThan(h1 + 50);
});

test("roles: commenters compose but can't edit others' notes; viewers read only", async ({
  browser,
}) => {
  const { page: admin, showId } = await exampleShow(browser);
  const { page: commenter } = await addMember(browser, admin, showId, "commenter");
  const { page: viewer } = await addMember(browser, admin, showId, "viewer");
  for (const p of [commenter, viewer]) {
    pages.push(p);
    trackErrors(p, errors);
  }

  // Commenter: others' notes are read-only; their own are editable.
  const panel = await openPanel(commenter, showId, "14.20");
  await panel.getByRole("tab", { name: /Notes/ }).click();
  const theirs = panel.getByTestId("note").first();
  await expect(theirs).toBeVisible();
  await expect(theirs.getByRole("button", { name: "Edit note" })).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: "Delete note" })).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: /^Status:/ })).toBeDisabled();
  // Cue fields are read-only for commenters.
  await panel.getByRole("tab", { name: "Fields" }).click();
  await expect(panel.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  await panel.getByRole("tab", { name: /Notes/ }).click();

  const body = uniqueName("commenter note");
  const compose = panel.getByRole("textbox", { name: "New note" });
  await compose.fill(body);
  await compose.press("Enter");
  const mine = panel.getByTestId("note").filter({ hasText: body });
  await expect(mine.getByRole("button", { name: "Edit note" })).toBeVisible();
  await mine.getByText(body).dblclick();
  const editor = mine.getByRole("textbox", { name: "Edit note" });
  await editor.fill(`${body} (edited)`);
  await editor.press("Enter");
  await expect(mine).toContainText(`${body} (edited)`);
  await expect
    .poll(async () =>
      (await snap(commenter, showId)).tables.notes.some((n) => n.body === `${body} (edited)`),
    )
    .toBe(true);

  // Remote notes appear for others.
  const adminPanel = await openPanel(admin, showId, "14.20");
  await adminPanel.getByRole("tab", { name: /Notes/ }).click();
  await expect(adminPanel.getByTestId("note").filter({ hasText: body })).toBeVisible();

  // Viewer: no compose box, nothing clickable.
  const vPanel = await openPanel(viewer, showId, "14.20");
  await vPanel.getByRole("tab", { name: /Notes/ }).click();
  await expect(vPanel.getByTestId("note").first()).toBeVisible();
  await expect(vPanel.getByRole("textbox", { name: "New note" })).toHaveCount(0);
  await expect(vPanel.getByText("You can read notes in this show but not add them.")).toBeVisible();
  await expect(vPanel.getByRole("button", { name: /^Status:/ }).first()).toBeDisabled();
  await viewer.goto(`/shows/${showId}/tech`);
  await expect(viewer.getByTestId("tech-mode")).toContainText("Read only");
  await expect(viewer.getByRole("textbox", { name: "Tech note" })).toHaveCount(0);
  await expect(viewer.getByRole("combobox", { name: "Session" })).toHaveCount(0);
});
