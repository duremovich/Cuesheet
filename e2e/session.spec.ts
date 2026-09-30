// What the app does when the session ends underneath it, and hostile ?next= values.
import { expect, test } from "@playwright/test";
import { ADMIN, createShow, login, uniqueName } from "./helpers";

test("a 401 from the API on the show page redirects to login with next=", async ({ page }) => {
  await login(page);
  const name = uniqueName("Expiring");
  const showId = await createShow(page, name);
  await page.getByRole("link", { name: "Cuesheet" }).click();
  await expect(page.getByTestId("show-list")).toContainText(name);

  // The session dies server-side while the SPA still thinks it's signed in.
  await page.request.post("/api/auth/logout", { data: {} });
  await page.getByRole("link", { name }).click(); // client-side navigation → GET 401

  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fshows%2F${showId}$`));
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("show-name")).toHaveText(name);
});

test("the socket retries a dropped connection but stops once its upgrade is refused", async ({
  page,
}) => {
  // Test-only instrumentation: remember the page's sockets so the test can drop one.
  // (Offline emulation doesn't close localhost WebSockets in Chromium.)
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
  const dropSocket = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __sockets: WebSocket[] }).__sockets;
      s.at(-1)?.close(4000, "test drop");
    });

  await login(page);
  await createShow(page, uniqueName("Refused"));
  const presence = page.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-status", "connected");

  // A plain drop while signed in: the client reconnects.
  await dropSocket();
  await expect(presence).toHaveAttribute("data-status", "disconnected");
  await expect(presence).toHaveAttribute("data-status", "connected");

  // End the session, then drop again: the reconnect's upgrade is refused (401).
  await page.request.post("/api/auth/logout", { data: {} });
  await dropSocket();
  await expect(presence).toHaveAttribute("data-status", "unauthorized", { timeout: 15_000 });
  await expect(presence).toContainText("No access");

  // Terminal: no further upgrade attempts.
  let attempts = 0;
  page.on("websocket", () => attempts++);
  await page.waitForTimeout(3_000);
  expect(attempts).toBe(0);
  await expect(presence).toHaveAttribute("data-status", "unauthorized");
});

for (const next of ["/\\example.com", "/%09/example.com", "//example.com", "https://example.com"]) {
  test(`login ignores an unsafe next=${JSON.stringify(next)}`, async ({ page }) => {
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Shows" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });
}
