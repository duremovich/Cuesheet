import { readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page } from "@playwright/test";

export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "",
  password: process.env.E2E_ADMIN_PASSWORD ?? "",
};

/** The e2e server's origin (playwright.config.ts). */
export const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:4317";

/** A record id the server accepts (lowercase UUIDv7), for ops sent through the API. */
export function recordId(): string {
  const hex = Date.now().toString(16).padStart(12, "0") + crypto.randomUUID().replace(/-/g, "");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Unique per test run so tests can share one server without colliding. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Signs in through the login form and waits for the show list. */
export async function login(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Shows" })).toBeVisible();
}

/** The show id in a /shows/<id>/<tab> URL. */
export function showIdFromUrl(url: string): string {
  const id = /\/shows\/([^/?#]+)/.exec(new URL(url).pathname)?.[1];
  if (!id) throw new Error(`no show id in ${url}`);
  return id;
}

/**
 * Waits until the show workspace has loaded its store (the first snapshot is in), so
 * what the test reads next is the show's data, not the loading state.
 */
export async function waitForShowReady(page: Page) {
  await expect(page.getByTestId("show-workspace")).toHaveAttribute("data-store-status", "ready");
}

/** Opens a show (optionally a tab path and query, e.g. `/content?view=…`) and waits for it. */
export async function openShow(page: Page, showId: string, path = "") {
  await page.goto(`/shows/${showId}${path}`);
  await waitForShowReady(page);
}

/** Creates a show from the show list (signed in, on `/`) and waits for its workspace. */
export async function createShow(page: Page, name: string): Promise<string> {
  await page.getByLabel("Show name").fill(name);
  await page.getByRole("button", { name: "New show" }).click();
  await page.waitForURL(/\/shows\/[^/]+/);
  await waitForShowReady(page);
  await expect(page.getByTestId("show-name")).toHaveText(name);
  return showIdFromUrl(page.url());
}

// ---- API shortcuts (faster than the UI for setting up data) ----

/** Signs the page's browser context in through the API (sets the session cookie). */
export async function apiLogin(page: Page, email = ADMIN.email, password = ADMIN.password) {
  const res = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(res.status()).toBe(200);
}

export async function apiCreateShow(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/shows", { data: { name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { show: { id: string } }).show.id;
}

export const EXAMPLE_FILES = [
  "Breakdown-Grid view.csv",
  "Personnel-Grid view.csv",
  "Content-Grid view.csv",
  "Cue List-Video Cue List View.csv",
  "Notes-NOTES.csv",
];

/** Imports example CSVs (default: all five core tables) like `pnpm seed:example`. */
export async function importExamples(page: Page, showId: string, files = EXAMPLE_FILES) {
  const form = new FormData();
  for (const f of files) {
    const text = readFileSync(path.join("examples", f), "utf8");
    form.append("files", new Blob([text], { type: "text/csv" }), f);
  }
  const res = await page.request.post(`/api/shows/${showId}/import/airtable`, {
    multipart: form,
    // Browsers send Origin on multipart posts; the CSRF check wants it.
    headers: { Origin: ORIGIN },
  });
  expect(res.status(), await res.text()).toBe(200);
}

export interface SnapshotCue {
  id: string;
  number: string | null;
  scene_id: string | null;
  description: string | null;
  is_section: boolean;
}

export async function snapshot(page: Page, showId: string) {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    tables: {
      cues: SnapshotCue[];
      scenes: { id: string; number: string | null; name: string | null }[];
      content: { id: string; name: string | null; scene_id: string | null }[];
    };
  };
}

/** A new user, invited through `admin`'s session and added to the show with `role`. */
export async function addMember(browser: Browser, admin: Page, showId: string, role: string) {
  const email = `${uniqueName(role).replace(/\s+/g, "-")}@cuesheet.test`;
  const invite = await admin.request.post("/api/invites", { data: { email } });
  const { path: invitePath } = (await invite.json()) as { path: string };
  const page = await (await browser.newContext()).newPage();
  const token = invitePath.split("/").at(-1);
  const accepted = await page.request.post(`/api/invites/${token}/accept`, {
    data: { name: `Test ${role}`, password: "a-long-password" },
  });
  expect(accepted.status()).toBe(201);
  const { user } = (await accepted.json()) as { user: { id: string } };
  const added = await admin.request.post(`/api/shows/${showId}/members`, {
    data: { email, role },
  });
  expect(added.status()).toBe(201);
  return { page, userId: user.id };
}

/** Collects console errors and uncaught exceptions of a page (assert it's empty at the end). */
export function trackErrors(page: Page, into: string[] = []): string[] {
  page.on("console", (m) => {
    if (m.type() === "error") into.push(`${m.text()} (${m.location().url})`);
  });
  page.on("pageerror", (e) => into.push(e.message));
  return into;
}
