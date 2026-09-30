// Where the script view reads and writes its data: the show store's `scripts` /
// `script_versions` / `cue_anchors` tables (CLAUDE.md "Script") and the script routes
// (import a version, fetch its text). Anchor ops go to the store in the same batch as the
// cue ops they belong with; the server derives `cue_anchors.page` and `cues.page`.
// Behind the `ScriptSource` interface so component tests can inject one.
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
import type { CueAnchorRow as StoredAnchorRow } from "../../../shared/tables";
import { api } from "../../lib/api";
import type { ShowStore } from "../../lib/show-store";
import {
  type CueAnchorRow,
  type ImportVersionResponse,
  normalizeAnchor,
  type ScriptRow,
  type ScriptText,
  type ScriptVersionRow,
} from "./contract";

/** Anchor fields a client writes (`block: null` only with state `missing`). */
export type AnchorFields = Omit<CueAnchorRow, "id" | "page" | "block"> & {
  block: number | null;
};

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
  subscribe(listener: () => void): () => void;
  getSnapshot(): ScriptSnapshot;
  /** One batch: the cue ops, then the anchor ops. Rejects (and changes nothing) on error. */
  apply(cueOps: Op[], anchorOps: AnchorOp[]): Promise<void>;
  /** Creates the version (made current) and re-anchors the previous version's cues. */
  importVersion(req: ImportVersionRequest): Promise<ImportVersionResponse>;
  /** Point a version at its original file (an attachment on its `source_file` field). */
  setOriginal(versionId: string, attachmentId: string): Promise<void>;
  fetchText(versionId: string): Promise<ScriptText>;
}

/** Anchor ops as store ops on `cue_anchors`. */
export function anchorStoreOps(ops: readonly AnchorOp[]): Op[] {
  return ops.map((o) =>
    o.op === "delete"
      ? { op: "delete", table: "cue_anchors", id: o.id }
      : ({ op: o.op, table: "cue_anchors", id: o.id, fields: o.fields } as Op),
  );
}

class LiveSource implements ScriptSource {
  private last: {
    anchorTable: ReadonlyMap<string, StoredAnchorRow>;
    snap: ScriptSnapshot;
  } | null = null;
  private texts = new Map<string, Promise<ScriptText>>();

  constructor(
    private readonly store: ShowStore,
    private readonly showId: string,
  ) {}

  subscribe = (l: () => void) => this.store.subscribe(l);

  getSnapshot = (): ScriptSnapshot => {
    const { tables } = this.store.getState();
    const prev = this.last;
    if (
      prev &&
      prev.snap.scripts === tables.scripts &&
      prev.snap.versions === tables.script_versions &&
      prev.anchorTable === tables.cue_anchors
    )
      return prev.snap;
    const anchors =
      prev && prev.anchorTable === tables.cue_anchors
        ? prev.snap.anchors
        : new Map([...tables.cue_anchors].map(([id, row]) => [id, normalizeAnchor(row)]));
    const snap = { scripts: tables.scripts, versions: tables.script_versions, anchors };
    this.last = { anchorTable: tables.cue_anchors, snap };
    return snap;
  };

  apply(cueOps: Op[], anchorOps: AnchorOp[]): Promise<void> {
    return this.store.mutate([...cueOps, ...anchorStoreOps(anchorOps)]);
  }

  async importVersion(req: ImportVersionRequest): Promise<ImportVersionResponse> {
    const res = await api.createScriptVersion(this.showId, {
      ...req,
      clientId: this.store.clientId,
    });
    this.texts.set(res.versionId, Promise.resolve(req.text));
    return res;
  }

  setOriginal(versionId: string, attachmentId: string): Promise<void> {
    return this.store.mutate([
      {
        op: "update",
        table: "script_versions",
        id: versionId,
        fields: { attachment_id: attachmentId },
      },
    ]);
  }

  fetchText(versionId: string): Promise<ScriptText> {
    let p = this.texts.get(versionId);
    if (!p) {
      p = api.scriptText(this.showId, versionId);
      p.catch(() => this.texts.delete(versionId));
      this.texts.set(versionId, p);
    }
    return p;
  }
}

// ---- React ----

export function createScriptSource(store: ShowStore, showId: string): ScriptSource {
  return new LiveSource(store, showId);
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
          (a.position ?? 0) - (b.position ?? 0) || (a.imported_at ?? 0) - (b.imported_at ?? 0),
      );
    const currentId = script?.current_version_id ?? versions.at(-1)?.id ?? null;
    return { script, versions, currentId };
  }, [snap.scripts, snap.versions]);
}
