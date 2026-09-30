// M5b: production security headers are on in the e2e build (the Worker serves pages with a
// Content-Security-Policy), and the app works under them: sign-in, the cue grid, a PDF
// script import (pdf.js and its worker), an attachment upload and its image. Any CSP
// violation fails the test.
import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  apiCreateShow,
  importExamples,
  login,
  openShow,
  snapshot,
  trackErrors,
  uniqueName,
} from "./helpers";

/** A 3-page PDF with page labels 14, 14a, 15. */
async function scriptPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (const [label, name, line] of [
    ["14", "JOE", "Sweet Sue needs a sax and a bass player"],
    ["14a", "SUGAR", "Runnin' wild, lost control"],
    ["15", "OSGOOD", "Nobody's perfect!"],
  ] as const) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 530, y: 750, size: 10, font });
    page.drawText(name, { x: 280, y: 690, size: 12, font });
    page.drawText(line, { x: 150, y: 676, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

/** 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("CSP on: headers; sign in, cue grid, PDF import, upload — no violations", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  const page = await context.newPage();
  const errors = trackErrors(page);

  const res = await page.goto("/login");
  const headers = res?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/);
  expect(csp).toContain("worker-src 'self' blob:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("geolocation=()");
  expect(headers["x-robots-tag"]).toContain("noindex");
  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /");
  const health = await page.request.get("/api/health");
  expect(await health.json()).toEqual({ ok: true, d1: true, do: true });

  // The theme script ran (its hash is allowed): the page is dark before React.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await login(page);
  const showId = await apiCreateShow(page, uniqueName("CSP"));
  await importExamples(page, showId);
  await openShow(page, showId, "/cues");
  await expect(page.getByRole("grid").first()).toBeVisible();

  // A PDF through pdf.js (a worker from our origin).
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "script.pdf",
    mimeType: "application/pdf",
    buffer: await scriptPdf(),
  });
  await expect(page.getByTestId("import-preview")).toContainText("3 pages", { timeout: 20_000 });
  await page.getByLabel("Version label").fill("CSP draft");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();

  // A photo on a note (quick add), then shown from the attachment route.
  const cue = (await snapshot(page, showId)).tables.cues.find((c) => !c.is_section);
  await page.goto(`/shows/${showId}/quick?cue=${cue?.id}`);
  await page.getByTestId("camera-input").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByRole("textbox", { name: "Quick note" }).fill(uniqueName("csp photo"));
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Saved to Cue/ })).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
