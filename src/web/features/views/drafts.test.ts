import { beforeEach, describe, expect, it } from "vitest";
import { defaultViewConfig, type ViewConfig } from "../../../shared/views";
import {
  DRAFT_MAX_AGE,
  type Draft,
  draftStorageKey,
  getDraft,
  rebaseDraft,
  resetDraftCache,
  setDraft,
} from "./drafts";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  },
});

beforeEach(() => {
  data.clear();
  resetDraftCache();
});

const base = defaultViewConfig("cues");
const draft = (config: ViewConfig, savedAt = Date.now()): Draft => ({
  config,
  base,
  baseUpdatedAt: 100,
  savedAt,
});

describe("view drafts", () => {
  it("persist across a reload (cache reset) and clear", () => {
    const d = draft({ ...base, rowHeight: "tall" });
    setDraft("k", d, true);
    resetDraftCache();
    expect(getDraft("k")).toEqual(d);
    setDraft("k", undefined);
    resetDraftCache();
    expect(getDraft("k")).toBeUndefined();
    expect(data.size).toBe(0);
  });

  it("drops stored drafts older than 7 days", () => {
    const now = Date.now();
    data.set(draftStorageKey("old"), JSON.stringify(draft(base, now - DRAFT_MAX_AGE - 1)));
    data.set(draftStorageKey("new"), JSON.stringify(draft(base, now - 1000)));
    expect(getDraft("old", now)).toBeUndefined();
    expect(data.has(draftStorageKey("old"))).toBe(false);
    expect(getDraft("new", now)).toBeDefined();
  });

  it("ignores damaged stored drafts", () => {
    data.set(draftStorageKey("bad"), JSON.stringify({ config: { filters: "x" } }));
    expect(getDraft("bad")).toBeUndefined();
  });

  it("rebase: your changed keys onto the newer saved config, the rest from it", () => {
    const mine = draft({
      ...base,
      filters: [{ key: "status", op: "is", value: "Cued" }],
      rowHeight: "compact",
    });
    const theirs: ViewConfig = { ...base, rowHeight: "tall", frozenCount: 2 };
    const out = rebaseDraft(mine, theirs);
    expect(out.filters).toEqual(mine.config.filters); // yours
    expect(out.rowHeight).toBe("compact"); // you changed it too: yours wins
    expect(out.frozenCount).toBe(2); // theirs (you didn't touch it)
  });
});
