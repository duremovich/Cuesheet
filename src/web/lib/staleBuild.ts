// Recovering from a stale build (docs/deploy.md, "Old tabs after a deploy").
//
// A deploy replaces every hashed file under /assets/: a tab opened before it still runs the
// old build, and the first time it needs a lazy chunk it hasn't loaded yet (the PDF reader,
// the calling-script print, papaparse, jszip, pdf.js…), that import fails (the server
// answers 404). The fix is to reload the page onto the new build, once:
//
// - `recoverFromStaleBuild()` reloads, unless the page already reloaded for this within
//   RELOAD_GUARD_MS (sessionStorage), i.e. the new build fails too: then it gives up with
//   state "prompt" and the UI asks the user to reload instead of looping.
// - Unsaved work is never dropped: while anything registered with `trackUnsavedWork` (the
//   show store's unsent batches, the attachment upload queue) has work in flight, the state
//   is "waiting" and the reload happens once it settles.
// - Triggers: Vite's `vite:preloadError` event (every bundled dynamic import goes through
//   its preload helper; `installStaleBuildRecovery` in main.tsx) and the router's error
//   element (`RouteError`), which sees a React.lazy / route `lazy` failure as a render error.
//   Both fire for the same failure; the second call is a no-op.

export type StaleState = "ok" | "waiting" | "reloading" | "prompt";

/** Something that may hold work a reload would lose (e.g. edits not yet sent). */
export interface UnsavedWork {
  busy(): boolean;
  /** Called on any change that may flip `busy`. */
  subscribe(listener: () => void): () => void;
}

export interface StaleBuildEnv {
  now(): number;
  reload(): void;
  /** sessionStorage, or null when unavailable (then never auto-reload: no loop guard). */
  storage(): Pick<Storage, "getItem" | "setItem"> | null;
}

export const RELOAD_KEY = "cuesheet:stale-build-reload";
/** A failure within this long after an automatic reload means the new build fails too. */
export const RELOAD_GUARD_MS = 60_000;

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i;

/** Whether an error is a failed lazy-chunk / dynamic import (any browser's wording). */
export function isChunkLoadError(e: unknown): boolean {
  if (e instanceof Error) return CHUNK_ERROR_RE.test(e.message) || e.name === "ChunkLoadError";
  return typeof e === "string" && CHUNK_ERROR_RE.test(e);
}

export class StaleBuild {
  private state: StaleState = "ok";
  private readonly listeners = new Set<() => void>();
  private readonly work = new Set<UnsavedWork>();
  private unwatch: (() => void)[] = [];

  constructor(private readonly env: StaleBuildEnv) {}

  getState = (): StaleState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Register a source of unsaved work; returns the unregister function. */
  trackUnsavedWork(w: UnsavedWork): () => void {
    this.work.add(w);
    if (this.state === "waiting") this.unwatch.push(w.subscribe(this.check));
    return () => {
      this.work.delete(w);
      if (this.state === "waiting") this.check();
    };
  }

  hasUnsavedWork(): boolean {
    for (const w of this.work) if (w.busy()) return true;
    return false;
  }

  /**
   * A chunk failed to load: reload onto the new build (now, or once unsaved work settles),
   * or give up ("prompt") when an automatic reload already happened moments ago. Returns
   * the resulting state. Idempotent within a page.
   */
  recover(): StaleState {
    if (this.state !== "ok") return this.state;
    const storage = this.env.storage();
    let last = Number.NaN;
    try {
      last = Number(storage?.getItem(RELOAD_KEY));
    } catch {
      // unreadable: treat like no storage below
    }
    const recent = Number.isFinite(last) && this.env.now() - last < RELOAD_GUARD_MS;
    if (!storage || recent) return this.set("prompt");
    if (!this.hasUnsavedWork()) return this.reloadNow();
    this.set("waiting");
    for (const w of this.work) this.unwatch.push(w.subscribe(this.check));
    return this.state;
  }

  /** The user's "Reload" button: reload regardless of the guard. */
  reloadByUser(): void {
    this.env.reload();
  }

  private check = (): void => {
    if (this.state === "waiting" && !this.hasUnsavedWork()) this.reloadNow();
  };

  private reloadNow(): StaleState {
    for (const u of this.unwatch.splice(0)) u();
    try {
      this.env.storage()?.setItem(RELOAD_KEY, String(this.env.now()));
    } catch {
      return this.set("prompt"); // can't record it: a reload could loop
    }
    this.set("reloading");
    this.env.reload();
    return this.state;
  }

  private set(s: StaleState): StaleState {
    this.state = s;
    for (const l of [...this.listeners]) l();
    return s;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The page's instance. */
export const staleBuild = new StaleBuild({
  now: () => Date.now(),
  reload: () => window.location.reload(),
  storage: browserStorage,
});

/** Listen for Vite's preload failures (main.tsx, once). */
export function installStaleBuildRecovery(target: Window = window): void {
  target.addEventListener("vite:preloadError", () => {
    staleBuild.recover();
  });
}
