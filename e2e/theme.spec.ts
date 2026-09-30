import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// Dark is the default whatever the OS says; only the user's own toggle changes it.
// Run the default case with a *light* system theme to prove the system is ignored.
test.describe("with a light system theme and no stored choice", () => {
  test.use({ colorScheme: "light" });

  test("loads dark; the toggle switches to light and persists across reload", async ({ page }) => {
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

  test("the signed-in app shell is dark and has the toggle in its header", async ({ page }) => {
    await login(page);
    expect(await theme(page)).toBe("dark");
    await expect(page.locator("header").getByTestId("theme-toggle")).toBeVisible();
  });
});

test.describe("with a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("a stored light choice still wins", async ({ page }) => {
    await page.goto("/login");
    expect(await theme(page)).toBe("dark");
    await page.getByTestId("theme-toggle").click();
    await page.reload();
    expect(await theme(page)).toBe("light");
  });
});
