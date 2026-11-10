// The asset routing that serveAsset (security.ts) relies on: the platform does no SPA
// fallback of its own (it would answer a missing /assets/ chunk with index.html, 200), and
// pages go through the Worker while hashed build files don't.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");

describe("wrangler.jsonc assets", () => {
  it("leaves the SPA fallback to the Worker", () => {
    expect(config).toMatch(/"not_found_handling":\s*"none"/);
    expect(config).not.toMatch(/"not_found_handling":\s*"single-page-application"/);
    expect(config).toMatch(/"run_worker_first":\s*\["\/\*",\s*"!\/assets\/\*"\]/);
  });
});
