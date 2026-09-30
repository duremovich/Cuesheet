// Import through the UI, the other tabs, members and the import-append flow. The cue grid
// itself is covered by e2e/cue-grid.spec.ts.
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  addMember,
  apiCreateShow,
  apiLogin,
  createShow,
  EXAMPLE_FILES,
  importExamples,
  login,
  recordId,
  uniqueName,
} from "./helpers";

test("import the example Airtable CSVs from Show settings; cues appear grouped by scene", async ({
  page,
}) => {
  test.slow();
  await login(page);
  await createShow(page, uniqueName("Some Like It Hot"));
  await expect(page).toHaveURL(/\/cues$/);
  await expect(page.getByTestId("cue-list")).toContainText("No cues yet.");
  await page.getByRole("button", { name: "Show settings" }).click();
  const settings = page.getByRole("dialog", { name: "Show settings" });
  await expect(settings.getByRole("button", { name: "Import Airtable CSVs…" })).toBeVisible();
  // The file input itself (Playwright sets files directly, no OS dialog).
  await page
    .getByLabel("Import Airtable CSVs…")
    .setInputFiles(EXAMPLE_FILES.map((f) => path.join("examples", f)));
  await expect(page.getByTestId("import-result")).toContainText(
    "Imported 28 scenes, 120 cues, 42 content, 319 notes, 31 people.",
  );
  await expect(page.getByTestId("cue-count")).toHaveText("120 cues");

  // Unassigned first (the export has no scene column for cues), then scenes in order.
  const grid = page.getByRole("grid", { name: "Cue list" });
  const headers = grid.getByTestId("group-header");
  await expect(headers.first()).toContainText("Unassigned");
  await grid.getByRole("button", { name: "Collapse Unassigned" }).click();
  await expect(headers.nth(1)).toContainText("99 Preshow");
  await grid.getByRole("button", { name: "Collapse 100 Overture" }).click();
  await grid.getByRole("button", { name: "Collapse 103 Scene Three: The Cheetah Club" }).click();
  const row = grid
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText("14.20", { exact: true }) });
  await expect(row.locator('[data-col="content"]')).toContainText("105-001-VAMP");
  await expect(row.locator('[data-col="sm_call"]')).toContainText("Sweet Sue needs a sax");
  await expect(row.locator('[data-col="scene"]')).toHaveText("105 Scene Five: Backstage");
  // Collapse state is remembered.
  await page.reload();
  await expect(grid.getByRole("button", { name: "Expand Unassigned" })).toBeVisible();
});

test("the other tabs show their tables", async ({ page }) => {
  await apiLogin(page);
  const showId = await apiCreateShow(page, uniqueName("Tabs"));
  await importExamples(page, showId);
  await page.goto(`/shows/${showId}/scenes`);
  const scenes = page.getByRole("grid", { name: "Scene list" });
  await expect(scenes.getByTestId("grid-row").first()).toContainText("99");
  await expect(scenes).toContainText("Scene Five: Backstage");

  await page.getByRole("link", { name: "Content", exact: true }).click();
  await expect(page).toHaveURL(/\/content$/);
  await expect(page.getByRole("grid", { name: "Content list" })).toContainText(
    "800-001-CH20-Room226",
  );

  await page.getByRole("link", { name: "Notes", exact: true }).click();
  const notes = page.getByRole("grid", { name: "Notes" });
  const headers = notes.getByTestId("group-header");
  await expect(headers).toHaveText([/Open/, /In progress/, /Done/]);
  // Done is collapsed by default.
  await expect(notes.getByRole("button", { name: "Expand Done" })).toBeVisible();
  await expect(notes).toContainText("make sure they get a millumin license");

  await page.getByRole("link", { name: "People", exact: true }).click();
  await expect(page.getByRole("grid", { name: "People" })).toContainText("Morgan Zielinski");

  // Add a scene at the end and name it.
  await page.getByRole("link", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "+ Add scene" }).click();
  await page.keyboard.type("300");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Curtain Call");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/shows/${showId}/snapshot`);
      const snap = (await res.json()) as { tables: { scenes: { number: string; name: string }[] } };
      const last = snap.tables.scenes.at(-1);
      return `${last?.number} ${last?.name}`;
    })
    .toBe("300 Curtain Call");

  // Deleting a scene asks first and says what happens to its cues.
  const overture = scenes
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText("100", { exact: true }) });
  await page.getByTestId("grid-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.dismiss();
  });
  await overture.locator('[data-col="name"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Delete row/ }).click();
  await expect
    .poll(() => message)
    .toBe("Delete scene 100 Overture? Its 11 cues move to Unassigned.");
  await expect(overture).toBeVisible(); // declined: nothing deleted
});

test("a commenter can add notes and edit only their own", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await apiLogin(admin);
  const showId = await apiCreateShow(admin, uniqueName("Commenter"));
  await importExamples(admin, showId, ["Notes-NOTES.csv"]);
  const { page } = await addMember(browser, admin, showId, "commenter");
  await page.goto(`/shows/${showId}/notes`);
  const notes = page.getByRole("grid", { name: "Notes" });
  const theirs = notes.getByTestId("grid-row").filter({ hasText: "millumin license" });
  await expect(theirs.locator('[data-col="body"]')).toHaveAttribute("aria-readonly", "true");

  await page.getByRole("button", { name: "+ Add note" }).click();
  await page.keyboard.type("Commenter note");
  await page.keyboard.press("Enter");
  const mine = notes.getByTestId("grid-row").filter({ hasText: "Commenter note" });
  await expect(mine).toBeVisible();
  await expect(mine.locator('[data-col="body"]')).not.toHaveAttribute("aria-readonly", "true");
  await expect(mine.locator('[data-col="created_by"]')).toHaveText("Test commenter");
  // No inserting cues.
  await page.getByRole("link", { name: "Cues", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add cue" })).toHaveCount(0);
  await admin.context().close();
  await page.context().close();
});

test("a member removed while the show is open sees No access and stays disconnected", async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin);
  const showId = await createShow(admin, uniqueName("Removal"));
  const { page: member, userId } = await addMember(browser, admin, showId, "editor");
  await member.goto(`/shows/${showId}`);
  const presence = member.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-status", "connected");

  // A browser's fetch sends Origin on DELETE; Playwright's request API doesn't (CSRF check).
  const res = await admin.request.delete(`/api/shows/${showId}/members/${userId}`, {
    headers: { Origin: new URL(admin.url()).origin },
  });
  expect(res.status()).toBe(200);
  await expect(presence).toHaveText(/No access/, { timeout: 2000 });
  await expect(presence).toHaveAttribute("data-status", "unauthorized");
  // It doesn't try to reconnect afterwards.
  await member.waitForTimeout(1500);
  await expect(presence).toHaveAttribute("data-status", "unauthorized");
  await admin.context().close();
  await member.context().close();
});

test("the owner manages members from Show settings", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin);
  const showId = await createShow(admin, uniqueName("Members"));
  const { page: member } = await addMember(browser, admin, showId, "viewer");
  await admin.reload();
  await admin.getByRole("button", { name: "Show settings" }).click();
  const list = admin.getByTestId("members");
  await expect(list).toContainText("Test viewer");
  await list.getByLabel("Role for Test viewer").selectOption("editor");
  await expect
    .poll(async () => {
      const res = await admin.request.get(`/api/shows/${showId}/members`);
      const { members } = (await res.json()) as { members: { name: string; role: string }[] };
      return members.find((m) => m.name === "Test viewer")?.role;
    })
    .toBe("editor");
  await admin.context().close();
  await member.context().close();
});

test("importing into a show with cues asks first and appends", async ({ page }) => {
  await login(page);
  const showId = await createShow(page, uniqueName("Append"));
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "create", table: "cues", id: recordId(), fields: { number: "1" } }],
    },
  });
  expect(res.status()).toBe(200);
  await expect(page.getByTestId("cue-count")).toHaveText("1 cue");
  const breakdown = path.join("examples", "Breakdown-Grid view.csv");
  // Declined: nothing is sent.
  page.once("dialog", (d) => {
    expect(d.message()).toContain("This show already has 1 cue. Import anyway?");
    void d.dismiss();
  });
  await page.getByLabel("Import Airtable CSVs…").setInputFiles(breakdown);
  await expect(page.getByTestId("import-result")).toHaveCount(0);
  // Accepted: rows are added.
  page.once("dialog", (d) => void d.accept());
  await page.getByLabel("Import Airtable CSVs…").setInputFiles(breakdown);
  await expect(page.getByTestId("import-result")).toContainText("Imported 28 scenes");
});
