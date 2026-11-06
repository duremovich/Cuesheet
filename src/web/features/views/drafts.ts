// Unsaved view configs ("working config") per user + show + view.
// - An editor's draft of a shared view is also kept in localStorage, so it survives a
//   reload (and shows "Unsaved changes") until Save or Discard. It remembers the saved
//   config it started from (`base`) and that view's `updated_at`: when the view changed
//   since, the draft is in conflict ("This view changed since your draft") and can be
//   rebased (`rebaseDraft`) or discarded, never silently saved over the newer view.
// - A personal view's draft bridges the debounce before it's written, and stays in
//   localStorage while a save couldn't reach the server (offline), to be retried.
// - Tabs of one browser share one stored draft per view: a draft another tab writes or
//   clears (the `storage` event) replaces this tab's at once, so two tabs on the same view
//   show the same unsaved changes, build on each other's and never overwrite each other's
//   in storage. A draft held only in this page (a personal view's change waiting for its
//   debounced save) isn't cleared by another tab.
// Stored drafts older than DRAFT_MAX_AGE are dropped when read.
import { useSyncExternalStore } from "react";
import { type ViewConfig, viewConfigError } from "../../../shared/views";
import { jsonEqual } from "../../lib/show-state";

export interface Draft {
  config: ViewConfig;
  /** The saved config the draft started from. */
  base: ViewConfig;
  /**
   * The view's `updated_at` (the server's stamp) when the draft started. Null: no saved
   * view yet, or it had unconfirmed local changes; set once the server confirms it.
   */
  baseUpdatedAt: number | null;
  /** When the draft was last written (ms). */
  savedAt: number;
}

export const DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Loaded entries; `undefined` = known to have no draft. */
const drafts = new Map<string, Draft | undefined>();
/** Keys whose current draft is in this page only (set without `persist`). */
const memoryOnly = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};

export const draftKey = (userId: string, showId: string, viewId: string) =>
  `${userId}.${showId}.${viewId}`;

/** localStorage key of a persisted draft. */
const STORAGE_PREFIX = "cuesheet.viewdraft.";
export const draftStorageKey = (key: string) => `${STORAGE_PREFIX}${key}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function load(key: string, now: number): Draft | undefined {
  try {
    const raw = storage()?.getItem(draftStorageKey(key));
    if (raw === null || raw === undefined) return undefined;
    const v = JSON.parse(raw) as Partial<Draft>;
    const ok =
      typeof v === "object" &&
      v !== null &&
      viewConfigError(v.config) === null &&
      viewConfigError(v.base) === null &&
      (typeof v.baseUpdatedAt === "number" || v.baseUpdatedAt === null) &&
      typeof v.savedAt === "number";
    if (!ok || now - (v.savedAt as number) > DRAFT_MAX_AGE) {
      storage()?.removeItem(draftStorageKey(key));
      return undefined;
    }
    return v as Draft;
  } catch {
    return undefined;
  }
}

export function getDraft(key: string, now = Date.now()): Draft | undefined {
  if (!drafts.has(key)) drafts.set(key, load(key, now));
  return drafts.get(key);
}

/** Set (or clear, with `undefined`) a draft; `persist` also keeps it in localStorage. */
export function setDraft(key: string, draft: Draft | undefined, persist = false): void {
  const had = getDraft(key);
  drafts.set(key, draft);
  if (draft !== undefined && !persist) memoryOnly.add(key);
  else memoryOnly.delete(key);
  try {
    if (draft === undefined) storage()?.removeItem(draftStorageKey(key));
    else if (persist) storage()?.setItem(draftStorageKey(key), JSON.stringify(draft));
  } catch {
    // storage blocked: the draft lasts for this page only
  }
  if (had === draft) return;
  notify();
}

/**
 * Another tab changed localStorage `storageKey` (null: cleared it all): re-read the drafts
 * it touched. Wired to the window's `storage` event below; exported for tests.
 */
export function onStorageChange(storageKey: string | null): void {
  if (storageKey !== null && !storageKey.startsWith(STORAGE_PREFIX)) return;
  const keys = storageKey === null ? [...drafts.keys()] : [storageKey.slice(STORAGE_PREFIX.length)];
  let changed = false;
  for (const key of keys) {
    if (!drafts.has(key)) continue; // not loaded here: read when first asked for
    const stored = storageHas(draftStorageKey(key));
    // Cleared elsewhere, but ours was never stored: it's this page's own, keep it.
    if (!stored && memoryOnly.has(key)) continue;
    memoryOnly.delete(key);
    drafts.delete(key);
    changed = true;
  }
  if (changed) notify();
}

function storageHas(storageKey: string): boolean {
  try {
    return (storage()?.getItem(storageKey) ?? null) !== null;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.storageArea === storage()) onStorageChange(e.key);
  });
}

/** Forget cached entries (tests). */
export function resetDraftCache(): void {
  drafts.clear();
  memoryOnly.clear();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDraft(key: string): Draft | undefined {
  return useSyncExternalStore(subscribe, () => getDraft(key));
}

/**
 * Your draft's changes applied onto the view as it is now: every top-level config key you
 * changed (draft differs from its base) takes your value; everything else is `latest`.
 */
export function rebaseDraft(draft: Draft, latest: ViewConfig): ViewConfig {
  const out: Record<string, unknown> = { ...latest };
  const mineCfg = draft.config as unknown as Record<string, unknown>;
  const baseCfg = draft.base as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(mineCfg), ...Object.keys(baseCfg)])) {
    if (!jsonEqual(mineCfg[k], baseCfg[k])) {
      if (mineCfg[k] === undefined) delete out[k];
      else out[k] = mineCfg[k];
    }
  }
  return out as unknown as ViewConfig;
}
