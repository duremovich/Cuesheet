// Unsaved view configs ("working config") per show + view, in memory for the page's life
// (they survive switching tabs, not a reload). A shared view's draft is what an editor
// sees until they Save or Discard; a personal view's draft only bridges the debounce before
// it's written.
import { useSyncExternalStore } from "react";
import type { ViewConfig } from "../../../shared/views";

const drafts = new Map<string, ViewConfig>();
const listeners = new Set<() => void>();

export const draftKey = (showId: string, viewId: string) => `${showId}:${viewId}`;

export function getDraft(key: string): ViewConfig | undefined {
  return drafts.get(key);
}

export function setDraft(key: string, config: ViewConfig | undefined): void {
  if (config === undefined) {
    if (!drafts.delete(key)) return;
  } else drafts.set(key, config);
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDraft(key: string): ViewConfig | undefined {
  return useSyncExternalStore(subscribe, () => drafts.get(key));
}
