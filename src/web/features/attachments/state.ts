// Page-wide attachment UI state: the upload queue and the open lightbox. Module singletons
// (one show is open at a time); React reads them with the hooks below. <AttachmentsHost>
// (in the show workspace) renders the lightbox and reports upload errors.
import { useSyncExternalStore } from "react";
import { api, putFile } from "../../lib/api";
import { shrinkLargeImage } from "./resize";
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
    prepare: shrinkLargeImage,
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
