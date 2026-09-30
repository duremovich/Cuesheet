// Unsaved view configs ("working config") per user + show + view.
// - An editor's draft of a shared view is also kept in localStorage, so it survives a
//   reload (and shows "Unsaved changes") until Save or Discard. It remembers the saved
//   config it started from (`base`) and that view's `updated_at`: when the view changed
//   since, the draft is in conflict ("This view changed since your draft") and can be
//   rebased (`rebaseDraft`) or discarded, never silently saved over the newer view.
// - A personal view's draft bridges the debounce before it's written, and stays in
//   localStorage while a save couldn't reach the server (offline), to be retried.
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
const listeners = new Set<() => void>();

export const draftKey = (userId: string, showId: string, viewId: string) =>
  `${userId}.${showId}.${viewId}`;

/** localStorage key of a persisted draft. */
export const draftStorageKey = (key: string) => `cuesheet.viewdraft.${key}`;

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
  try {
    if (draft === undefined) storage()?.removeItem(draftStorageKey(key));
    else if (persist) storage()?.setItem(draftStorageKey(key), JSON.stringify(draft));
  } catch {
    // storage blocked: the draft lasts for this page only
  }
  if (had === draft) return;
  for (const l of [...listeners]) l();
}

/** Forget cached entries (tests). */
export function resetDraftCache(): void {
  drafts.clear();
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
