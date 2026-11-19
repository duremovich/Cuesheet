// Teams and delegated invites through the UI: a team owner adds an existing account and
// creates a show in the team, which the new member then sees; an editor invites a guest to
// a show, sees the pending invite and revokes it (the link dies); removing someone from a
// team closes their open tab of the team's show at once. Every user but the shared admin
// (who only sends the sign-up invites) is new to the test.
import { expect, test } from "@playwright/test";
import {
  addMember,
  apiCreateShow,
  apiLogin,
  newUser,
  openShow,
  uniqueName,
  waitForShowReady,
} from "./helpers";

test("a team owner adds an existing account as editor and creates a show in the team; the editor sees it", async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  await apiLogin(admin);
  const owner = await newUser(browser, admin, "Team owner");
  const editor = await newUser(browser, admin, "Team editor");
  const page = owner.page;

  await page.goto("/");
  await page.getByRole("button", { name: "New team" }).click();
  const teamName = uniqueName("Crew");
  await page.getByLabel("Team name").fill(teamName);
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByTestId("team-name")).toHaveText(teamName);

  const add = page.getByRole("form", { name: "Add people" });
  await add.getByLabel("Email").fill(editor.email);
  await add.getByLabel("Role").selectOption("editor");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("add-people-result")).toContainText(
    `Added ${editor.name} as editor`,
  );
  const row = page
    .getByTestId("team-members")
    .getByRole("listitem")
    .filter({ hasText: editor.name });
  await expect(row).toContainText(`Invited by ${owner.name}`);
  await expect(row.getByLabel(`Role for ${editor.name}`)).toHaveValue("editor");

  // A show in the team, from the show list.
  await page.getByRole("link", { name: "← Shows" }).click();
  const showName = uniqueName("Team show");
  await page.getByLabel("Show name").fill(showName);
  // The label also reads the selected option ("Team Personal").
  await page.getByRole("combobox", { name: /^Team/ }).selectOption({ label: teamName });
  await page.getByRole("button", { name: "New show" }).click();
  await page.waitForURL(/\/shows\/[^/]+/);
  await waitForShowReady(page);

  // The editor finds it under the team, as an editor, and gets in.
  await editor.page.goto("/");
  const group = editor.page.getByRole("region", { name: teamName });
  await expect(group.getByRole("link", { name: teamName })).toBeVisible();
  const link = group.getByRole("link", { name: showName });
  await expect(link).toContainText("editor");
  await link.click();
  await waitForShowReady(editor.page);
  await expect(editor.page.getByTestId("show-name")).toHaveText(showName);
  await editor.page.getByRole("button", { name: "Show settings" }).click();
  const me = editor.page
    .getByTestId("members")
    .getByRole("listitem")
    .filter({ hasText: editor.name });
  await expect(me).toContainText(`via ${teamName}`);
  await expect(me.getByTestId("member-role")).toHaveText("editor");

  await admin.context().close();
  await page.context().close();
  await editor.page.context().close();
});

test("an editor invites a guest as commenter, sees the pending invite, revokes it, and the link dies", async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  await apiLogin(admin);
  const showId = await apiCreateShow(admin, uniqueName("Guests"));
  const { page: editor } = await addMember(browser, admin, showId, "editor");
  await openShow(editor, showId);
  await editor.getByRole("button", { name: "Show settings" }).click();
  const settings = editor.getByRole("dialog", { name: "Show settings" });

  const guest = `${uniqueName("guest").replace(/\s+/g, "-")}@cuesheet.test`;
  const add = settings.getByRole("form", { name: "Add people" });
  await add.getByLabel("Email").fill(guest);
  await add.getByLabel("Role").selectOption("commenter");
  await add.getByRole("button", { name: "Add" }).click();
  const result = settings.getByTestId("add-people-result");
  await expect(result).toContainText(`Invite created for ${guest} as commenter`);
  // No email is set up in e2e: the link is there to copy.
  await expect(result).toContainText("Email not sent: copy the link below.");

  // The link, once: on the invite's row in the pending list.
  const pending = settings
    .getByTestId("pending-invites")
    .getByRole("listitem")
    .filter({ hasText: guest });
  await expect(pending).toContainText("commenter");
  await expect(settings.getByTestId("add-people-result").locator("code")).toHaveCount(0);
  const link = (await pending.getByTestId("pending-invite-link").textContent()) ?? "";
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  await expect(pending).toContainText("Invited by Test editor");
  await pending.getByRole("button", { name: `Revoke the invite for ${guest}` }).click();
  await pending.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(settings.getByTestId("pending-invites")).toHaveCount(0);

  // The link stops working (one bad-token failure: within the per-IP limit).
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(link);
  await expect(visitor.getByRole("alert")).toContainText("invalid or has already been used");

  await admin.context().close();
  await editor.context().close();
  await visitor.context().close();
});

test("removing someone from a team closes their open tab of the team's show", async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  await apiLogin(admin);
  const owner = await newUser(browser, admin, "Team owner");
  const member = await newUser(browser, admin, "Team member");
  const teamName = uniqueName("Crew");
  const made = await owner.page.request.post("/api/teams", { data: { name: teamName } });
  expect(made.status()).toBe(201);
  const { team } = (await made.json()) as { team: { id: string } };
  const added = await owner.page.request.post(`/api/teams/${team.id}/people`, {
    data: { email: member.email, role: "editor" },
  });
  expect(added.status()).toBe(201);
  const show = await owner.page.request.post("/api/shows", {
    data: { name: uniqueName("Team show"), teamId: team.id },
  });
  expect(show.status()).toBe(201);
  const { show: created } = (await show.json()) as { show: { id: string } };

  await openShow(member.page, created.id);
  const presence = member.page.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-status", "connected");

  await owner.page.goto(`/teams/${team.id}`);
  const row = owner.page
    .getByTestId("team-members")
    .getByRole("listitem")
    .filter({ hasText: member.name });
  await row.getByRole("button", { name: `Remove ${member.name}` }).click();
  await row.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);

  await expect(presence).toHaveText(/No access/);
  await expect(presence).toHaveAttribute("data-status", "unauthorized");

  await admin.context().close();
  await owner.page.context().close();
  await member.page.context().close();
});
