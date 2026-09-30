import { describe, expect, it } from "vitest";
import {
  formatSeconds,
  parseDate,
  parseDateTime,
  parseDuration,
  parseTimecode,
  parseUrl,
  urlHref,
} from "./values";

const now = new Date(2026, 8, 30); // 30 Sep 2026, local

describe("custom field input", () => {
  it("dates", () => {
    expect(parseDate("2026-09-30")).toEqual({ value: "2026-09-30" });
    expect(parseDate("9/3/2026")).toEqual({ value: "2026-09-03" });
    expect(parseDate("9/3/26")).toEqual({ value: "2026-09-03" });
    expect(parseDate("3.9.2026")).toEqual({ value: "2026-09-03" });
    expect(parseDate("today", now)).toEqual({ value: "2026-09-30" });
    expect(parseDate("tomorrow", now)).toEqual({ value: "2026-10-01" });
    expect(parseDate("2026-02-30")).toMatchObject({ error: expect.any(String) });
    expect(parseDate("next week")).toMatchObject({ error: expect.any(String) });
    expect(parseDate("  ")).toBeNull();
  });

  it("dates and times", () => {
    expect(parseDateTime("2026-09-30 19:30")).toEqual({ value: "2026-09-30T19:30" });
    expect(parseDateTime("9/30/2026 7:30pm")).toEqual({ value: "2026-09-30T19:30" });
    expect(parseDateTime("2026-09-30T07:05")).toEqual({ value: "2026-09-30T07:05" });
    expect(parseDateTime("today 12am", now)).toEqual({ value: "2026-09-30T00:00" });
    expect(parseDateTime("2026-09-30 25:00")).toMatchObject({ error: expect.any(String) });
    expect(parseDateTime("2026-09-30")).toMatchObject({ error: expect.any(String) });
  });

  it("durations", () => {
    expect(parseDuration("1:30")).toEqual({ value: "0:01:30" });
    expect(parseDuration("0:01:30.5")).toEqual({ value: "0:01:30.5" });
    expect(parseDuration("90")).toEqual({ value: "0:01:30" });
    expect(parseDuration("90s")).toEqual({ value: "0:01:30" });
    expect(parseDuration("1h 5m")).toEqual({ value: "1:05:00" });
    expect(parseDuration("2m 5.25s")).toEqual({ value: "0:02:05.25" });
    expect(parseDuration("1:75")).toMatchObject({ error: expect.any(String) });
    expect(parseDuration("soon")).toMatchObject({ error: expect.any(String) });
    expect(formatSeconds(3600.1)).toBe("1:00:00.1");
  });

  it("timecodes", () => {
    expect(parseTimecode("01:00:10:12")).toEqual({ value: "01:00:10:12" });
    expect(parseTimecode("1:00:10:12")).toEqual({ value: "01:00:10:12" });
    expect(parseTimecode("01:00:10;12")).toEqual({ value: "01:00:10;12" });
    expect(parseTimecode("01001012")).toEqual({ value: "01:00:10:12" });
    expect(parseTimecode("01:61:10:12")).toMatchObject({ error: expect.any(String) });
    expect(parseTimecode("1:00")).toMatchObject({ error: expect.any(String) });
  });

  it("URLs", () => {
    expect(parseUrl("example.com/x")).toEqual({ value: "https://example.com/x" });
    expect(parseUrl("https://a.b/c d")).toEqual({ value: "https://a.b/c d" });
    expect(parseUrl("mailto:x@y.z")).toEqual({ value: "mailto:x@y.z" });
    expect(parseUrl("not a url")).toMatchObject({ error: expect.any(String) });
    expect(urlHref("https://x.y")).toBe("https://x.y");
    expect(urlHref("javascript:alert(1)")).toBeNull();
  });
});
