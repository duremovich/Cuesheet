import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const theme = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);
const bodyBg = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// Note: Chromium reports "no-preference" as light, so the "default" case is a dark (or
// unset) system theme. A light system theme is honoured until the user picks one.
test.describe("with a dark (default) system theme", () => {
  test.use({ colorScheme: "dark" });

  test("loads dark by default; the toggle switches to light and persists", async ({ page }) => {
    await page.goto("/login");
    expect(await theme(page)).toBe("dark");
    expect(await bodyBg(page)).toBe("rgb(24, 26, 30)"); // --color-bg (dark)

    await page.getByTestId("theme-toggle").click();
    expect(await theme(page)).toBe("light");
    expect(await bodyBg(page)).toBe("rgb(245, 246, 248)"); // --color-bg (light)

    await page.reload();
    expect(await theme(page)).toBe("light");
    await expect(page.getByTestId("theme-toggle")).toHaveAccessibleName("Switch to dark theme");

    await page.getByTestId("theme-toggle").click();
    await page.reload();
    expect(await theme(page)).toBe("dark");
  });

  test("the app shell (signed in) is dark too", async ({ page }) => {
    await login(page);
    expect(await theme(page)).toBe("dark");
    await expect(page.getByTestId("theme-toggle")).toBeVisible(); // toggle in the app header
  });
});

test.describe("with a system light preference", () => {
  test.use({ colorScheme: "light" });

  test("follows the system until the user chooses", async ({ page }) => {
    await page.goto("/login");
    expect(await theme(page)).toBe("light");
    await page.getByTestId("theme-toggle").click();
    await page.reload();
    expect(await theme(page)).toBe("dark"); // explicit choice beats the system
  });
});
