import { describe, expect, it } from "vitest";
import {
  isChunkLoadError,
  RELOAD_GUARD_MS,
  RELOAD_KEY,
  StaleBuild,
  type StaleBuildEnv,
  type UnsavedWork,
} from "./staleBuild";

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

function setup(opts: { storage?: StaleBuildEnv["storage"]; now?: number } = {}) {
  const storage = memoryStorage();
  const t = { now: opts.now ?? 1_000_000 };
  let reloads = 0;
  const sb = new StaleBuild({
    now: () => t.now,
    reload: () => {
      reloads++;
    },
    storage: opts.storage ?? (() => storage),
  });
  return { sb, storage, t, reloads: () => reloads };
}

/** A source of unsaved work the test flips. */
function work(busy: boolean) {
  const listeners = new Set<() => void>();
  const w: UnsavedWork & { set(b: boolean): void } = {
    busy: () => busy,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(b) {
      busy = b;
      for (const l of [...listeners]) l();
    },
  };
  return w;
}

describe("isChunkLoadError", () => {
  it("recognises each browser's failed dynamic import and Vite's CSS preload error", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://x/assets/PdfReader-ESiLCMse.js",
      "error loading dynamically imported module: https://x/assets/PdfReader-ESiLCMse.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/PdfReader-a1.css",
    ]) {
      expect(isChunkLoadError(new TypeError(msg)), msg).toBe(true);
    }
  });

  it("leaves other errors alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ status: 404 })).toBe(false);
  });
});

describe("StaleBuild", () => {
  it("reloads once and records when", () => {
    const { sb, storage, reloads } = setup();
    expect(sb.recover()).toBe("reloading");
    expect(reloads()).toBe(1);
    expect(storage.data.get(RELOAD_KEY)).toBe("1000000");
    // The same failure reported twice (preload event + router error): still one reload.
    expect(sb.recover()).toBe("reloading");
    expect(reloads()).toBe(1);
  });

  it("asks instead of reloading again when the last automatic reload was moments ago", () => {
    const { sb, storage, t, reloads } = setup();
    storage.setItem(RELOAD_KEY, String(t.now - 5_000));
    const states: string[] = [];
    sb.subscribe(() => states.push(sb.getState()));
    expect(sb.recover()).toBe("prompt");
    expect(reloads()).toBe(0);
    expect(states).toEqual(["prompt"]);
    sb.reloadByUser();
    expect(reloads()).toBe(1);
  });

  it("reloads again after the guard window (a later deploy)", () => {
    const { sb, storage, t, reloads } = setup();
    storage.setItem(RELOAD_KEY, String(t.now - RELOAD_GUARD_MS - 1));
    expect(sb.recover()).toBe("reloading");
    expect(reloads()).toBe(1);
  });

  it("never auto-reloads without sessionStorage (no loop guard)", () => {
    const { sb, reloads } = setup({ storage: () => null });
    expect(sb.recover()).toBe("prompt");
    expect(reloads()).toBe(0);
    const throwing = setup({
      storage: () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    });
    expect(throwing.sb.recover()).toBe("prompt");
    expect(throwing.reloads()).toBe(0);
  });

  it("waits for unsaved work, then reloads", () => {
    const { sb, reloads } = setup();
    const a = work(true);
    const b = work(false);
    sb.trackUnsavedWork(a);
    sb.trackUnsavedWork(b);
    expect(sb.recover()).toBe("waiting");
    expect(reloads()).toBe(0);
    b.set(true);
    a.set(false);
    expect(reloads()).toBe(0);
    b.set(false);
    expect(sb.getState()).toBe("reloading");
    expect(reloads()).toBe(1);
    a.set(false);
    expect(reloads()).toBe(1);
  });

  it("work registered while waiting holds the reload too; unregistering releases it", () => {
    const { sb, reloads } = setup();
    const a = work(true);
    const untrackA = sb.trackUnsavedWork(a);
    expect(sb.recover()).toBe("waiting");
    const c = work(true);
    sb.trackUnsavedWork(c);
    a.set(false);
    expect(reloads()).toBe(0);
    untrackA();
    c.set(false);
    expect(reloads()).toBe(1);
  });

  it("doesn't reload for work that's done (nothing busy)", () => {
    const { sb, reloads } = setup();
    sb.trackUnsavedWork(work(false));
    expect(sb.recover()).toBe("reloading");
    expect(reloads()).toBe(1);
  });
});
