// The upload queue (R13): files dropped, pasted or picked anywhere in a show go through
// here: checked (type, size), then reserved (POST upload-url) and PUT into R2 by the
// Worker, a few at a time, with progress. The attachment row itself arrives through the
// show socket like any other change; an item leaves the queue once its PUT succeeds.
// An item can wait for its record to exist first (`ready`): a note's photos are queued while
// the note is being saved.
import { useSyncExternalStore } from "react";
import type { UploadUrlRequest, UploadUrlResponse } from "../../../shared/api";
import { checkAttachmentType, MAX_ATTACHMENT_BYTES } from "../../../shared/attachments";

export interface UploadTarget {
  table: string;
  recordId: string;
  field?: string;
}

export type UploadStatus = "waiting" | "uploading" | "error";

export interface UploadItem {
  key: string;
  showId: string;
  target: UploadTarget;
  filename: string;
  size: number;
  /** Bytes sent so far. */
  loaded: number;
  status: UploadStatus;
  error?: string;
}

export interface UploadTransport {
  reserve(showId: string, req: UploadUrlRequest): Promise<UploadUrlResponse>;
  put(
    url: string,
    file: Blob,
    contentType: string,
    onProgress: (loaded: number) => void,
  ): Promise<void>;
}

type Listener = () => void;

interface Entry {
  item: UploadItem;
  file: Blob;
  ready: Promise<unknown>;
  started: boolean;
}

let seq = 0;

export class UploadQueue {
  private entries: Entry[] = [];
  private listeners = new Set<Listener>();
  private active = 0;
  /** Snapshot of the items (a new array on every change). */
  private items: UploadItem[] = [];

  constructor(
    private readonly transport: UploadTransport,
    private readonly opts: { concurrency?: number; onError?: (item: UploadItem) => void } = {},
  ) {}

  /**
   * Queue files for a record. Files that can't be uploaded (type, size) come back as error
   * items straight away. `ready` resolves once the record exists on the server.
   */
  add(
    showId: string,
    target: UploadTarget,
    files: readonly File[],
    opts: { ready?: Promise<unknown> } = {},
  ): UploadItem[] {
    const ready = opts.ready ?? Promise.resolve();
    const added: UploadItem[] = [];
    for (const file of files) {
      const item: UploadItem = {
        key: `u${++seq}`,
        showId,
        target,
        filename: file.name || "file",
        size: file.size,
        loaded: 0,
        status: "waiting",
      };
      const type = checkAttachmentType(file.type, item.filename);
      if ("error" in type) Object.assign(item, { status: "error", error: type.error });
      else if (file.size > MAX_ATTACHMENT_BYTES) {
        Object.assign(item, {
          status: "error",
          error: `${item.filename} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
        });
      }
      this.entries.push({ item, file, ready, started: item.status === "error" });
      added.push(item);
      if (item.status === "error") this.opts.onError?.(item);
    }
    this.changed();
    this.pump();
    return added;
  }

  /** Forget a failed item. */
  dismiss(key: string): void {
    this.entries = this.entries.filter((e) => e.item.key !== key);
    this.changed();
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getItems = (): UploadItem[] => this.items;

  /** Resolves when nothing is waiting or uploading (tests). */
  async idle(): Promise<void> {
    while (this.entries.some((e) => e.item.status !== "error")) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private changed(): void {
    this.items = this.entries.map((e) => e.item);
    for (const l of [...this.listeners]) l();
  }

  private update(entry: Entry, patch: Partial<UploadItem>): void {
    entry.item = { ...entry.item, ...patch };
    this.changed();
  }

  private pump(): void {
    const limit = this.opts.concurrency ?? 2;
    while (this.active < limit) {
      const next = this.entries.find((e) => !e.started);
      if (!next) return;
      next.started = true;
      this.active++;
      void this.run(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { item } = entry;
    try {
      try {
        await entry.ready;
      } catch {
        throw new Error("The record wasn't saved, so its files weren't uploaded");
      }
      this.update(entry, { status: "uploading" });
      const reserved = await this.transport.reserve(item.showId, {
        table: item.target.table,
        recordId: item.target.recordId,
        field: item.target.field ?? "attachments",
        filename: item.filename,
        contentType: entry.file.type,
        size: item.size,
      });
      await this.transport.put(reserved.uploadUrl, entry.file, reserved.contentType, (loaded) =>
        this.update(entry, { loaded }),
      );
      this.entries = this.entries.filter((e) => e !== entry);
      this.changed();
    } catch (e) {
      this.update(entry, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      this.opts.onError?.(entry.item);
    }
  }
}

/** Items for one record (waiting, uploading or failed), from a queue's item list. */
export function uploadsFor(items: readonly UploadItem[], table: string, recordId: string) {
  return items.filter((i) => i.target.table === table && i.target.recordId === recordId);
}

/** Fraction done of an item (0–1). */
export function progressOf(item: UploadItem): number {
  return item.size > 0 ? Math.min(1, item.loaded / item.size) : item.status === "error" ? 0 : 1;
}

const NONE: UploadItem[] = [];
const recordCache = new WeakMap<readonly UploadItem[], Map<string, UploadItem[]>>();

/** A record's uploads, live (the same array while they don't change). */
export function useRecordUploads(queue: UploadQueue, table: string, recordId: string) {
  const items = useSyncExternalStore(queue.subscribe, queue.getItems);
  let cache = recordCache.get(items);
  if (!cache) {
    cache = new Map();
    recordCache.set(items, cache);
  }
  const k = `${table}:${recordId}`;
  let list = cache.get(k);
  if (!list) {
    const found = uploadsFor(items, table, recordId);
    list = found.length ? found : NONE;
    cache.set(k, list);
  }
  return list;
}
