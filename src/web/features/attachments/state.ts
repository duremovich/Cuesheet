// Page-wide attachment UI state: the upload queue, the open lightbox, and deletes waiting
// out their Undo window. Module singletons (one show is open at a time); React reads them
// with the hooks below. <AttachmentsHost> (in the show workspace) renders the lightbox and
// reports upload errors.
import { useSyncExternalStore } from "react";
import { api, putFile } from "../../lib/api";
import { UploadQueue } from "./uploads";

type Listener = () => void;

/** A tiny observable value. */
class Cell<T> {
  private listeners = new Set<Listener>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set(v: T): void {
    this.value = v;
    for (const l of [...this.listeners]) l();
  }
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

function useCell<T>(cell: Cell<T>): T {
  return useSyncExternalStore(cell.subscribe, cell.get, cell.get);
}

// ---- uploads ----

export const uploadErrors = new Cell<{ filename: string; error: string } | null>(null);

export const uploadQueue = new UploadQueue(
  {
    reserve: (showId, req) => api.uploadUrl(showId, req),
    put: (url, file, contentType, onProgress) => putFile(url, file, contentType, onProgress),
  },
  {
    onError: (item) => uploadErrors.set({ filename: item.filename, error: item.error ?? "" }),
  },
);

// ---- lightbox ----

export interface LightboxTarget {
  table: string;
  recordId: string;
  field: string;
  /** The file shown first. */
  attachmentId: string;
}

export const lightbox = new Cell<LightboxTarget | null>(null);

export function openLightbox(target: LightboxTarget | null): void {
  lightbox.set(target);
}

export function useLightbox(): LightboxTarget | null {
  return useCell(lightbox);
}

// ---- deletes with Undo ----

/** How long a deleted file can still be brought back (its bytes go when the op is sent). */
export const UNDO_MS = 8000;

interface PendingDelete {
  timer: number;
  send: (keepalive: boolean) => void;
}

const pending = new Map<string, PendingDelete>();
export const hiddenFiles = new Cell<ReadonlySet<string>>(new Set());

function publish(): void {
  hiddenFiles.set(new Set(pending.keys()));
}

/**
 * Hide a file now and delete it after UNDO_MS (R2 objects go with the row, so the delete
 * can't be undone once sent). `send(keepalive)` sends the delete op; keepalive when the
 * page is going away.
 */
export function scheduleDelete(id: string, send: (keepalive: boolean) => void): void {
  if (pending.has(id)) return;
  const timer = window.setTimeout(() => {
    pending.delete(id);
    publish();
    send(false);
  }, UNDO_MS);
  pending.set(id, { timer, send });
  publish();
}

export function undoDelete(id: string): void {
  const p = pending.get(id);
  if (!p) return;
  window.clearTimeout(p.timer);
  pending.delete(id);
  publish();
}

/** Send every waiting delete now (the page is being hidden or left). */
export function flushDeletes(keepalive: boolean): void {
  for (const [id, p] of [...pending]) {
    window.clearTimeout(p.timer);
    pending.delete(id);
    p.send(keepalive);
  }
  publish();
}

export function useHiddenFiles(): ReadonlySet<string> {
  return useCell(hiddenFiles);
}
