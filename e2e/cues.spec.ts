import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createShow, login, uniqueName } from "./helpers";

const EXAMPLES = [
  "Breakdown-Grid view.csv",
  "Personnel-Grid view.csv",
  "Content-Grid view.csv",
  "Cue List-Video Cue List View.csv",
  "Notes-NOTES.csv",
].map((f) => path.join("examples", f));

/** Cue numbers in the order the list shows them. */
async function cueNumbers(page: Page): Promise<string[]> {
  return page.getByTestId("cue-number").allTextContents();
}

async function addCue(page: Page, number: string, opts: { after?: string } = {}) {
  const form = page.getByRole("form", { name: "Add cue" });
  await form.getByLabel("Number").fill(number);
  if (opts.after) await form.getByLabel("Insert after").selectOption({ label: opts.after });
  await form.getByRole("button", { name: "Add cue" }).click();
}

test("import the example Airtable CSVs; cues appear grouped by scene", async ({ page }) => {
  test.slow();
  await login(page);
  await createShow(page, uniqueName("Some Like It Hot"));
  await page.getByLabel("Import Airtable CSVs…").setInputFiles(EXAMPLES);
  await expect(page.getByTestId("import-result")).toContainText(
    "Imported 28 scenes, 120 cues, 42 content, 319 notes, 31 people.",
  );
  await expect(page.getByTestId("cue-row")).toHaveCount(120);

  // Unassigned first (the export has no scene column for cues), then scenes in order.
  const headers = page.getByTestId("scene-header");
  await expect(headers.first()).toContainText("Unassigned");
  await expect(headers.nth(1)).toContainText("99 Preshow");
  const vamp = page.getByTestId("scene-group").filter({ hasText: "105 Scene Five: Backstage" });
  const row = vamp.getByTestId("cue-row").filter({ hasText: "14.20" });
  await expect(row).toContainText("105-001-VAMP");
  await expect(row).toContainText("Sweet Sue needs a sax");
});

async function signedInPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page);
  return page;
}

test("a cue inserted in one browser appears in place in another without reload", async ({
  browser,
}) => {
  const a = await signedInPage(browser);
  const showId = await createShow(a, uniqueName("Realtime"));
  await addCue(a, "1");
  await addCue(a, "3");
  await expect.poll(() => cueNumbers(a)).toEqual(["1", "3"]);

  const b = await signedInPage(browser);
  await b.goto(`/shows/${showId}`);
  await expect.poll(() => cueNumbers(b)).toEqual(["1", "3"]);
  await expect(b.getByTestId("presence-count")).toHaveText("2 clients");

  await addCue(a, "2", { after: "1" });
  await expect.poll(() => cueNumbers(a)).toEqual(["1", "2", "3"]);
  await expect.poll(() => cueNumbers(b)).toEqual(["1", "2", "3"]);

  // And the other way round.
  await addCue(b, "0.5");
  await expect.poll(() => cueNumbers(a)).toEqual(["1", "2", "3", "0.5"]);
  await a.context().close();
  await b.context().close();
});

test("a viewer sees the cue list but can't add cues", async ({ browser }) => {
  const admin = await signedInPage(browser);
  const showId = await createShow(admin, uniqueName("Viewer check"));
  await addCue(admin, "1");

  // A new user, invited and added to the show as a viewer.
  const email = `${uniqueName("viewer").replace(/\s+/g, "-")}@cuesheet.test`;
  const invite = await admin.request.post("/api/invites", { data: { email } });
  const { path: invitePath } = (await invite.json()) as { path: string };
  const viewer = await (await browser.newContext()).newPage();
  const token = invitePath.split("/").at(-1);
  const accepted = await viewer.request.post(`/api/invites/${token}/accept`, {
    data: { name: "Vera Viewer", password: "a-long-password" },
  });
  expect(accepted.status()).toBe(201);
  const added = await admin.request.post(`/api/shows/${showId}/members`, {
    data: { email, role: "viewer" },
  });
  expect(added.status()).toBe(201);

  await viewer.goto(`/shows/${showId}`);
  await expect.poll(() => cueNumbers(viewer)).toEqual(["1"]);
  await expect(viewer.getByRole("form", { name: "Add cue" })).toHaveCount(0);
  await expect(viewer.getByText("Import Airtable CSVs…")).toHaveCount(0);
  const res = await viewer.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "x",
      ops: [
        { op: "create", table: "cues", id: "0190aaaa-0000-7000-8000-000000000000", fields: {} },
      ],
    },
  });
  expect(res.status()).toBe(403);
  await admin.context().close();
  await viewer.context().close();
});
