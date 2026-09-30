// Where the script view reads and writes its data. Two implementations of one interface:
//
// - live: the show store's `scripts` / `script_versions` / `cue_anchors` tables (M4a's
//   ShowDO migration 0006) and M4a's routes (import a version, fetch its text). Anchor ops
//   go to the store in the same batch as the cue ops they belong with.
// - mock (VITE_SCRIPT_MOCK=1): the same data kept in this browser's localStorage per show,
//   with the local stand-in re-anchoring (./mock/anchorText.ts). Cue ops still go to the
//   real store (cue.page is set by the mock, since there's no server to derive it). Used
//   to build and test the UI before M4a lands; see contract.ts.
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Op } from "../../../shared/ops";
import type { TableName } from "../../../shared/tables";
import { ApiError, UnauthorizedError } from "../../lib/api";
import type { ShowStore } from "../../lib/show-store";
import type {
  CueAnchorRow,
  ImportVersionResponse,
  ScriptRow,
  ScriptText,
  ScriptVersionRow,
} from "./contract";
import { reanchor } from "./mock/anchorText";

export type AnchorFields = Omit<CueAnchorRow, "id" | "page">;

export type AnchorOp =
  | { op: "create"; id: string; fields: AnchorFields }
  | { op: "update"; id: string; fields: Partial<AnchorFields> }
  | { op: "delete"; id: string };

export interface ScriptSnapshot {
  scripts: ReadonlyMap<string, ScriptRow>;
  versions: ReadonlyMap<string, ScriptVersionRow>;
  anchors: ReadonlyMap<string, CueAnchorRow>;
}

export interface ImportVersionRequest {
  versionId: string;
  label: string;
  text: ScriptText;
}

export interface ScriptSource {
  readonly mode: "live" | "mock";
  subscribe(listener: () => void): () => void;
  getSnapshot(): ScriptSnapshot;
  /** One batch: the cue ops, then the anchor ops. Rejects (and changes nothing) on error. */
  apply(cueOps: Op[], anchorOps: AnchorOp[]): Promise<void>;
  /** Creates the version (made current) and re-anchors the previous version's cues. */
  importVersion(req: ImportVersionRequest): Promise<ImportVersionResponse>;
  /** Point a version at its original file (an attachment on `script_versions`). */
  setOriginal(versionId: string, attachmentId: string): Promise<void>;
  fetchText(versionId: string): Promise<ScriptText>;
}

const EMPTY = new Map<string, never>();

// ---- live ----

type AnyTables = Record<string, ReadonlyMap<string, unknown> | undefined>;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  const message = data?.error ?? `Request failed (${res.status})`;
  if (res.status === 401) throw new UnauthorizedError(message);
  if (!res.ok) throw new ApiError(res.status, message);
  return data as T;
}

/** Anchor ops as store ops on `cue_anchors`. */
export function anchorStoreOps(ops: readonly AnchorOp[]): Op[] {
  const table = "cue_anchors" as TableName;
  return ops.map((o) =>
    o.op === "delete"
      ? { op: "delete", table, id: o.id }
      : ({ op: o.op, table, id: o.id, fields: o.fields } as unknown as Op),
  );
}

class LiveSource implements ScriptSource {
  readonly mode = "live" as const;
  private last: { tables: unknown; snap: ScriptSnapshot } | null = null;
  private texts = new Map<string, Promise<ScriptText>>();

  constructor(
    private readonly store: ShowStore,
    private readonly showId: string,
  ) {}

  subscribe = (l: () => void) => this.store.subscribe(l);

  getSnapshot = (): ScriptSnapshot => {
    const tables = this.store.getState().tables as unknown as AnyTables;
    const scripts = (tables.scripts ?? EMPTY) as ScriptSnapshot["scripts"];
    const versions = (tables.script_versions ?? EMPTY) as ScriptSnapshot["versions"];
    const anchors = (tables.cue_anchors ?? EMPTY) as ScriptSnapshot["anchors"];
    const prev = this.last?.snap;
    if (prev && prev.scripts === scripts && prev.versions === versions && prev.anchors === anchors)
      return prev;
    const snap = { scripts, versions, anchors };
    this.last = { tables, snap };
    return snap;
  };

  apply(cueOps: Op[], anchorOps: AnchorOp[]): Promise<void> {
    return this.store.mutate([...cueOps, ...anchorStoreOps(anchorOps)]);
  }

  async importVersion(req: ImportVersionRequest): Promise<ImportVersionResponse> {
    const res = await request<ImportVersionResponse>(
      "POST",
      `/shows/${encodeURIComponent(this.showId)}/script/versions`,
      req,
    );
    this.texts.set(res.versionId, Promise.resolve(req.text));
    return res;
  }

  setOriginal(versionId: string, attachmentId: string): Promise<void> {
    return this.store.mutate([
      {
        op: "update",
        table: "script_versions" as TableName,
        id: versionId,
        fields: { attachment_id: attachmentId },
      },
    ]);
  }

  fetchText(versionId: string): Promise<ScriptText> {
    let p = this.texts.get(versionId);
    if (!p) {
      p = request<ScriptText>(
        "GET",
        `/shows/${encodeURIComponent(this.showId)}/script/versions/${encodeURIComponent(versionId)}/text`,
      );
      p.catch(() => this.texts.delete(versionId));
      this.texts.set(versionId, p);
    }
    return p;
  }
}

// ---- mock ----

interface MockState {
  script: ScriptRow | null;
  versions: ScriptVersionRow[];
  anchors: CueAnchorRow[];
  texts: Record<string, ScriptText>;
}

export const mockKey = (showId: string) => `cuesheet.scriptmock.${showId}`;

function readMock(showId: string): MockState {
  try {
    const raw = localStorage.getItem(mockKey(showId));
    if (raw) return JSON.parse(raw) as MockState;
  } catch {
    // unavailable storage: start empty
  }
  return { script: null, versions: [], anchors: [], texts: {} };
}

function pageLabel(text: ScriptText | undefined, block: number): string | null {
  const page = text?.blocks[block]?.page;
  if (page === undefined) return null;
  return text?.pages.find((p) => p.page === page)?.label ?? String(page);
}

export class MockSource implements ScriptSource {
  readonly mode = "mock" as const;
  private state: MockState;
  private snap: ScriptSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: ShowStore,
    private readonly showId: string,
  ) {
    this.state = readMock(showId);
    this.snap = this.build();
    window.addEventListener("storage", this.onStorage);
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key !== mockKey(this.showId)) return;
    this.state = readMock(this.showId);
    this.changed(false);
  };

  private build(): ScriptSnapshot {
    const s = this.state;
    return {
      scripts: new Map(s.script ? [[s.script.id, s.script]] : []),
      versions: new Map(s.versions.map((v) => [v.id, v])),
      anchors: new Map(s.anchors.map((a) => [a.id, a])),
    };
  }

  private changed(save = true) {
    if (save) {
      try {
        localStorage.setItem(mockKey(this.showId), JSON.stringify(this.state));
      } catch {
        // storage full / blocked: this page only
      }
    }
    this.snap = this.build();
    for (const l of [...this.listeners]) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snap;

  /** `cues.page` from each placed anchor on the current version (the server does this live). */
  private pageOps(anchors: CueAnchorRow[]): Op[] {
    const current = this.state.script?.current_version_id;
    if (!current) return [];
    const text = this.state.texts[current];
    const cues = this.store.getState().tables.cues;
    const ops: Op[] = [];
    for (const a of anchors) {
      if (a.script_version_id !== current || !cues.has(a.cue_id)) continue;
      const label = a.state === "missing" ? null : pageLabel(text, a.block);
      if ((cues.get(a.cue_id)?.page ?? null) !== label)
        ops.push({ op: "update", table: "cues", id: a.cue_id, fields: { page: label } });
    }
    return ops;
  }

  private applyAnchorOps(anchors: CueAnchorRow[], ops: readonly AnchorOp[]): CueAnchorRow[] {
    let next = [...anchors];
    for (const o of ops) {
      if (o.op === "create") {
        const text = this.state.texts[o.fields.script_version_id];
        next.push({ id: o.id, ...o.fields, page: text?.blocks[o.fields.block]?.page ?? null });
      } else if (o.op === "update") {
        next = next.map((a) => {
          if (a.id !== o.id) return a;
          const merged = { ...a, ...o.fields };
          const text = this.state.texts[merged.script_version_id];
          return { ...merged, page: text?.blocks[merged.block]?.page ?? null };
        });
      } else next = next.filter((a) => a.id !== o.id);
    }
    return next;
  }

  async apply(cueOps: Op[], anchorOps: AnchorOp[]): Promise<void> {
    const next = this.applyAnchorOps(this.state.anchors, anchorOps);
    const touched = new Set(anchorOps.map((o) => o.id));
    const changedAnchors = next.filter((a) => touched.has(a.id));
    const created = new Set(
      cueOps.flatMap((o) => (o.op === "create" && o.table === "cues" ? [o.id] : [])),
    );
    // Pages for cues created in this batch are set in their create op.
    const withPages = cueOps.map((o) => {
      if (o.op !== "create" || !created.has(o.id)) return o;
      const a = changedAnchors.find((x) => x.cue_id === o.id);
      const text = a ? this.state.texts[a.script_version_id] : undefined;
      return a ? { ...o, fields: { ...o.fields, page: pageLabel(text, a.block) } } : o;
    });
    const pageOps = this.pageOps(changedAnchors.filter((a) => !created.has(a.cue_id)));
    const ops = [...withPages, ...pageOps];
    if (ops.length) await this.store.mutate(ops);
    this.state = { ...this.state, anchors: next };
    this.changed();
  }

  async importVersion(req: ImportVersionRequest): Promise<ImportVersionResponse> {
    const s = this.state;
    const now = Date.now();
    const script: ScriptRow = s.script ?? {
      id: `mock-script-${now}`,
      title: null,
      current_version_id: null,
    };
    const prevId = script.current_version_id;
    const version: ScriptVersionRow = {
      id: req.versionId,
      script_id: script.id,
      label: req.label,
      attachment_id: null,
      imported_at: now,
      source: req.text.source,
      confidence: req.text.confidence,
      text_key: null,
      block_count: req.text.blocks.length,
      page_count: req.text.pages.length,
      stats: null,
      position: s.versions.length,
    };
    const texts = { ...s.texts, [req.versionId]: req.text };
    const prevText = prevId ? s.texts[prevId] : undefined;
    const cues = this.store.getState().tables.cues;
    const prevAnchors = prevId
      ? s.anchors.filter((a) => a.script_version_id === prevId && cues.has(a.cue_id))
      : [];
    const results = prevText
      ? reanchor(
          prevText,
          req.text,
          prevAnchors
            .filter((a) => a.state !== "missing")
            .map((a) => ({ cueId: a.cue_id, anchor: a })),
        )
      : [];
    const created: CueAnchorRow[] = results.map((r, n) => {
      const to = r.to ?? { ...r.from, block: 0, offset: 0, length: 0 };
      return {
        id: `mock-anchor-${now}-${n}`,
        cue_id: r.cueId,
        script_version_id: req.versionId,
        block: to.block,
        offset: to.offset,
        length: to.length,
        quote: to.quote,
        prefix: to.prefix,
        suffix: to.suffix,
        page: r.to ? (req.text.blocks[to.block]?.page ?? null) : null,
        state: r.state,
        confidence: r.confidence,
      };
    });
    this.state = {
      script: { ...script, current_version_id: req.versionId },
      versions: [...s.versions, version],
      anchors: [...s.anchors, ...created],
      texts,
    };
    const pageOps = this.pageOps(created);
    if (pageOps.length) await this.store.mutate(pageOps).catch(() => undefined);
    this.changed();
    return { versionId: req.versionId, results };
  }

  async setOriginal(versionId: string, attachmentId: string): Promise<void> {
    this.state = {
      ...this.state,
      versions: this.state.versions.map((v) =>
        v.id === versionId ? { ...v, attachment_id: attachmentId } : v,
      ),
    };
    this.changed();
  }

  async fetchText(versionId: string): Promise<ScriptText> {
    const t = this.state.texts[versionId];
    if (!t) throw new Error("That script version's text isn't available");
    return t;
  }
}

// ---- React ----

export const SCRIPT_MOCK = import.meta.env.VITE_SCRIPT_MOCK === "1";

export function createScriptSource(store: ShowStore, showId: string): ScriptSource {
  return SCRIPT_MOCK ? new MockSource(store, showId) : new LiveSource(store, showId);
}

const SourceContext = createContext<ScriptSource | null>(null);

/** Provides the show's script source (mounted once in the show workspace). */
export function ScriptSourceProvider({
  store,
  showId,
  source,
  children,
}: {
  store: ShowStore;
  showId: string;
  /** Tests inject one. */
  source?: ScriptSource;
  children: ReactNode;
}) {
  const made = useRef<{ key: unknown; source: ScriptSource } | null>(null);
  if (!source && (!made.current || made.current.key !== store)) {
    made.current = { key: store, source: createScriptSource(store, showId) };
  }
  const value = source ?? (made.current as { source: ScriptSource }).source;
  return createElement(SourceContext.Provider, { value }, children);
}

export function useScriptSource(): ScriptSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error("useScriptSource must be used inside <ScriptSourceProvider>");
  return s;
}

export function useScriptSnapshot(): ScriptSnapshot {
  const source = useScriptSource();
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

/** The show's script (one per show) and its versions, oldest first. */
export function useScriptVersions() {
  const snap = useScriptSnapshot();
  return useMemo(() => {
    const script = [...snap.scripts.values()][0] ?? null;
    const versions = [...snap.versions.values()]
      .filter((v) => !script || v.script_id === script.id)
      .sort(
        (a, b) =>
          (a.position ?? 0) - (b.position ?? 0) ||
          importedMs(a.imported_at) - importedMs(b.imported_at),
      );
    const currentId = script?.current_version_id ?? versions.at(-1)?.id ?? null;
    return { script, versions, currentId };
  }, [snap.scripts, snap.versions]);
}

export function importedMs(v: number | string | null): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v) || 0;
  return 0;
}
