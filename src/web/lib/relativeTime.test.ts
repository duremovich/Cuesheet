import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 10, 18, 12);

describe("relativeTime", () => {
  it("says how long ago or how far ahead, in the largest whole unit", () => {
    expect(relativeTime(NOW - 20 * 1000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe("3 days ago");
    expect(relativeTime(NOW - DAY, NOW)).toBe("yesterday");
    expect(relativeTime(NOW + 6 * DAY, NOW)).toBe("in 6 days");
    expect(relativeTime(NOW - 40 * DAY, NOW)).toBe("last month");
  });
});
