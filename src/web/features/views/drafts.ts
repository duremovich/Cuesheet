// Unsaved view configs ("working config") per user + show + view. An editor's draft of a
// shared view is also kept in localStorage, so it survives a reload (and shows "Unsaved
// changes") until Save or Discard. A personal view's draft is memory-only: it just bridges
// the debounce before it's written.
import { useSyncExternalStore } from "react";
import { type ViewConfig, viewConfigError } from "../../../shared/views";

/** Loaded entries; `undefined` = known to have no draft. */
const drafts = new Map<string, ViewConfig | undefined>();
const listeners = new Set<() => void>();

export const draftKey = (userId: string, showId: string, viewId: string) =>
  `${userId}.${showId}.${viewId}`;

/** localStorage key of a persisted draft. */
export const draftStorageKey = (key: string) => `cuesheet.viewdraft.${key}`;

function load(key: string): ViewConfig | undefined {
  try {
    const raw = localStorage.getItem(draftStorageKey(key));
    if (raw === null) return undefined;
    const v: unknown = JSON.parse(raw);
    return viewConfigError(v) === null ? (v as ViewConfig) : undefined;
  } catch {
    return undefined;
  }
}

export function getDraft(key: string): ViewConfig | undefined {
  if (!drafts.has(key)) drafts.set(key, load(key));
  return drafts.get(key);
}

/** Set (or clear, with `undefined`) a draft; `persist` also keeps it in localStorage. */
export function setDraft(key: string, config: ViewConfig | undefined, persist = false): void {
  const had = getDraft(key);
  drafts.set(key, config);
  try {
    if (config === undefined) localStorage.removeItem(draftStorageKey(key));
    else if (persist) localStorage.setItem(draftStorageKey(key), JSON.stringify(config));
  } catch {
    // storage blocked: the draft lasts for this page only
  }
  if (had === config) return;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDraft(key: string): ViewConfig | undefined {
  return useSyncExternalStore(subscribe, () => getDraft(key));
}
