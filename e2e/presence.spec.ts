// Presence (R22): the header counts people, not connections, and reloads leave no ghosts.
import { expect, test } from "@playwright/test";
import { addMember, createShow, login, openShow, uniqueName, waitForShowReady } from "./helpers";

test("reloading the show page leaves no ghost connections", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  await createShow(page, uniqueName("Reloads"));
  const presence = page.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-clients", "1");
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await waitForShowReady(page);
    await expect(presence).toHaveAttribute("data-status", "connected");
    // The old page's socket closed (pagehide): one connection, one person.
    await expect(presence).toHaveAttribute("data-clients", "1");
    await expect(page.getByTestId("presence-count")).toHaveText("1 online");
  }
  await context.close();
});

test("one account in two tabs is one person, listed once with its tabs", async ({ browser }) => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await login(a);
  const showId = await createShow(a, uniqueName("Two tabs, one person"));
  const b = await context.newPage();
  await openShow(b, showId);
  const presence = a.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-clients", "2");
  await expect(presence).toHaveAttribute("data-people", "1");
  await expect(a.getByTestId("presence-count")).toHaveText("1 online");
  await a.getByRole("button", { name: "1 online: who's here" }).click();
  const list = a.getByTestId("presence-list");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem")).toHaveText("Admin · 2 tabs");

  // Someone else joins: two people.
  const { page: other } = await addMember(browser, a, showId, "editor");
  await openShow(other, showId);
  await expect(presence).toHaveAttribute("data-people", "2");
  await expect(a.getByTestId("presence-count")).toHaveText("2 online");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").filter({ hasText: "Test editor" })).toHaveText(
    "Test editor",
  );

  // A tab closes: still Admin, now without the note.
  await b.close();
  await expect(presence).toHaveAttribute("data-clients", "2");
  await expect(list.getByRole("listitem").filter({ hasText: "Admin" })).toHaveText("Admin");
  await other.context().close();
  await expect(a.getByTestId("presence-count")).toHaveText("1 online");
  await context.close();
});
