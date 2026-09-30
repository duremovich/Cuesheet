// The per-show client store: server-confirmed state + a queue of optimistic local batches.
// The grid and every other show view read from here and write through `mutate`.
// Design: docs/decisions/0006-mutation-ops-and-sync.md.
//
//   visible = pending batches applied over `confirmed`
//
// - mutate(ops): resolve locally (order keys, defaults), show at once, send (one request at
//   a time, in order), then reconcile with the server's resolved ops; on error roll back
//   and rethrow.
// - WS `ops` with prevVersion == our version: apply. Our own echo (same clientId) also
//   retires the batch in flight. prevVersion > our version: we missed something → refetch
//   the snapshot. `version` messages newer than ours → refetch.
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Role } from "../../shared/api";
import { newId } from "../../shared/ids";
import type {
  MutateRequest,
  MutateResponse,
  Op,
  ResolvedOp,
  SnapshotResponse,
} from "../../shared/ops";
import type { OrderedTableName, Row, TableName } from "../../shared/tables";
import { isOrderedTable } from "../../shared/tables";
import type { ServerMessage } from "../../shared/ws";
import { api } from "./api";
import { applyResolved, emptyData, fromSnapshot, resolveLocal, type ShowData } from "./show-state";
import { type ShowSocketState, useShowSocket } from "./useShowSocket";

export type { Op, ResolvedOp } from "../../shared/ops";
export type { AnyRow, FieldOption, FieldOptions, Row, TableName } from "../../shared/tables";
export type { ShowData } from "./show-state";

export type StoreStatus = "loading" | "ready" | "error";

/** Immutable snapshot of what the UI shows (confirmed + optimistic). */
export interface ShowState extends ShowData {
  status: StoreStatus;
  /** Set when status is "error" (the snapshot couldn't load). */
  error: string | null;
  /**
   * Your role, when the server announced a change while the show is open (`{type:"role"}`);
   * null until then (use the role the show was opened with).
   */
  role: Role | null;
  /**
   * Show-level fields that can change while the show is open (`{type:"show"}` messages,
   * or `setShow` after a PATCH): the name and the current session label.
   */
  show: ShowMeta | null;
}

/** Show-level fields kept in D1 and relayed live. */
export interface ShowMeta {
  name: string;
  currentSession: string | null;
}

export type Listener = () => void;

export interface ShowStore {
  readonly version: number;
  readonly status: StoreStatus;
  readonly tables: ShowState["tables"];
  readonly order: ShowState["order"];
  readonly joins: ShowState["joins"];
  readonly fieldOptions: ShowState["fieldOptions"];
  /** Optimistic: applies locally at once, sends, reconciles; on error rolls back and rethrows. */
  mutate(ops: Op[]): Promise<void>;
  subscribe(listener: Listener): () => void;
  getState(): ShowState;
  /** This store's id, sent with each batch and echoed in broadcasts. */
  readonly clientId: string;
  /** Refetch the snapshot. */
  refresh(): Promise<void>;
  /** Replace the show-level fields (after a PATCH, before its broadcast arrives). */
  setShow(show: ShowMeta): void;
}

/** How the store talks to the server (injectable for tests). */
export interface ShowTransport {
  snapshot(): Promise<SnapshotResponse>;
  mutate(req: MutateRequest): Promise<MutateResponse>;
}

export function httpTransport(showId: string): ShowTransport {
  return {
    snapshot: () => api.snapshot(showId),
    mutate: (req) => api.mutate(showId, req),
  };
}

interface Pending {
  ops: Op[];
  /** Locally resolved ops (provisional keys, timestamps). */
  local: ResolvedOp[];
  /** Server's answer, kept while our confirmed state hasn't caught up to it yet. */
  acked?: MutateResponse;
}

export interface StoreOptions {
  /** Used for created_by/updated_by on optimistic rows. */
  userId?: string;
  clientId?: string;
  now?: () => number;
  /** Initial show-level fields (from GET /api/shows/:id). */
  show?: ShowMeta;
}

export class ShowStoreImpl implements ShowStore {
  readonly clientId: string;
  private confirmed: ShowData = emptyData();
  private visible: ShowState;
  private loadStatus: StoreStatus = "loading";
  private error: string | null = null;
  private role: Role | null = null;
  private show: ShowMeta | null = null;
  private pending: Pending[] = [];
  private inflight: Pending | null = null;
  private sendChain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  /** Messages that arrive while a snapshot is loading; replayed after it. */
  private buffered: ServerMessage[] | null = null;
  private refetchAgain = false;
  private disposed = false;
  private readonly userId: string;
  private readonly now: () => number;

  constructor(
    private readonly transport: ShowTransport,
    opts: StoreOptions = {},
  ) {
    this.clientId = opts.clientId ?? newId();
    this.userId = opts.userId ?? "";
    this.now = opts.now ?? Date.now;
    this.show = opts.show ?? null;
    this.visible = {
      ...this.confirmed,
      status: "loading",
      error: null,
      role: null,
      show: this.show,
    };
  }

  // ---- ShowStore ----

  get version() {
    return this.visible.version;
  }
  get tables() {
    return this.visible.tables;
  }
  get order() {
    return this.visible.order;
  }
  get joins() {
    return this.visible.joins;
  }
  get fieldOptions() {
    return this.visible.fieldOptions;
  }
  get status() {
    return this.visible.status;
  }

  getState = (): ShowState => this.visible;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mutate = async (ops: Op[]): Promise<void> => {
    if (ops.length === 0) return;
    const local = resolveLocal(this.visible, ops, { userId: this.userId, now: this.now() });
    const p: Pending = { ops, local };
    this.pending.push(p);
    this.recompute();
    const send = this.sendChain.then(() => this.send(p));
    this.sendChain = send.catch(() => undefined);
    return send;
  };

  // ---- lifecycle ----

  /** Load the initial snapshot. */
  load(): Promise<void> {
    return this.refetch();
  }

  /** Refetch the snapshot (e.g. after an import, in case the socket missed it). */
  refresh(): Promise<void> {
    return this.refetch();
  }

  setShow = (show: ShowMeta): void => {
    const cur = this.show;
    if (cur && cur.name === show.name && cur.currentSession === show.currentSession) return;
    this.show = { name: show.name, currentSession: show.currentSession };
    this.recompute();
  };

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Feed a WebSocket message in. */
  handleServerMessage = (msg: ServerMessage): void => {
    if (this.disposed) return;
    if (msg.type === "role") {
      this.role = msg.role;
      this.recompute();
      return;
    }
    if (msg.type === "show") {
      this.setShow(msg);
      return;
    }
    if (msg.type !== "ops" && msg.type !== "version") return;
    if (this.buffered) {
      this.buffered.push(msg);
      return;
    }
    const v = this.confirmed.version;
    if (msg.type === "version") {
      if (msg.version > v) void this.refetch();
      return;
    }
    if (msg.version <= v) return; // already have it (e.g. applied from our HTTP ack)
    if (msg.prevVersion !== v) {
      void this.refetch(); // gap
      return;
    }
    this.confirmed = { ...applyResolved(this.confirmed, msg.ops), version: msg.version };
    if (msg.clientId === this.clientId && this.inflight && !this.inflight.acked) {
      // Our own batch, committed: its effects are now in `confirmed`.
      this.drop(this.inflight);
    }
    this.dropCaughtUp();
    this.recompute();
  };

  // ---- internals ----

  private async send(p: Pending): Promise<void> {
    if (this.disposed) return;
    this.inflight = p;
    let res: MutateResponse;
    try {
      res = await this.transport.mutate({ clientId: this.clientId, ops: p.ops });
    } catch (e) {
      this.inflight = null;
      this.drop(p);
      this.recompute();
      throw e;
    }
    this.inflight = null;
    if (!this.pending.includes(p)) return; // our echo already retired it
    const v = this.confirmed.version;
    if (res.version === res.prevVersion || v >= res.version) {
      this.drop(p);
    } else if (v === res.prevVersion) {
      this.confirmed = { ...applyResolved(this.confirmed, res.ops), version: res.version };
      this.drop(p);
    } else {
      // Something committed before our batch that we haven't seen: show the server's
      // version of our batch until a snapshot catches us up.
      p.acked = res;
      void this.refetch();
    }
    this.recompute();
  }

  private async refetch(): Promise<void> {
    if (this.buffered) {
      this.refetchAgain = true;
      return;
    }
    this.buffered = [];
    try {
      do {
        this.refetchAgain = false;
        const snap = await this.transport.snapshot();
        if (this.disposed) return;
        // Structural sharing: rows that didn't change keep their identity (no re-render).
        this.confirmed = fromSnapshot(snap, this.confirmed);
        this.loadStatus = "ready";
        this.error = null;
      } while (this.refetchAgain);
    } catch (e) {
      if (this.loadStatus === "loading") {
        this.loadStatus = "error";
        this.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      const replay = this.buffered ?? [];
      this.buffered = null;
      this.dropCaughtUp();
      this.recompute();
      for (const msg of replay) this.handleServerMessage(msg);
    }
  }

  /** Retire acked batches whose version the confirmed state has reached. */
  private dropCaughtUp(): void {
    const v = this.confirmed.version;
    this.pending = this.pending.filter((p) => !p.acked || p.acked.version > v);
  }

  private drop(p: Pending): void {
    this.pending = this.pending.filter((x) => x !== p);
  }

  private recompute(): void {
    let data = this.confirmed;
    for (const p of this.pending) data = applyResolved(data, p.acked?.ops ?? p.local);
    this.visible = {
      ...data,
      status: this.loadStatus,
      error: this.error,
      role: this.role,
      show: this.show,
    };
    for (const l of [...this.listeners]) l();
  }
}

// ---- React ----

const StoreContext = createContext<ShowStoreImpl | null>(null);
const SocketContext = createContext<ShowSocketState>({ status: "connecting", clients: 0 });

/** Creates the store for a show, loads it, and feeds it from the show's WebSocket. */
export function ShowStoreProvider({
  showId,
  userId,
  show,
  children,
}: {
  showId: string;
  userId?: string;
  /** Initial show-level fields (name, current session). */
  show?: ShowMeta;
  children: ReactNode;
}) {
  const [store, setStore] = useState<ShowStoreImpl | null>(null);
  const storeRef = useRef<ShowStoreImpl | null>(null);
  const initialShow = useRef(show);
  initialShow.current = show;
  useEffect(() => {
    const s = new ShowStoreImpl(httpTransport(showId), {
      ...(userId ? { userId } : {}),
      ...(initialShow.current ? { show: initialShow.current } : {}),
    });
    storeRef.current = s;
    setStore(s);
    void s.load();
    return () => {
      s.dispose();
      storeRef.current = null;
    };
  }, [showId, userId]);
  const onMessage = useCallback((msg: ServerMessage) => {
    storeRef.current?.handleServerMessage(msg);
  }, []);
  const socket = useShowSocket(showId, onMessage);
  if (!store) return null;
  return createElement(
    StoreContext.Provider,
    { value: store },
    createElement(SocketContext.Provider, { value: socket }, children),
  );
}

export function useShowStoreInstance(): ShowStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useShowStore* must be used inside <ShowStoreProvider>");
  return store;
}

/** Presence/connection state of the show's socket. */
export function useShowSocketState(): ShowSocketState {
  return useContext(SocketContext);
}

/**
 * Subscribe to a slice of the store. The selector must return something stable for the
 * same state (a row, a Map, an array from the state), not a freshly built object.
 */
export function useShowStore<T>(selector: (s: ShowState) => T): T {
  const store = useShowStoreInstance();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useRow<T extends TableName>(table: T, id: string): Row<T> | undefined {
  return useShowStore((s) => s.tables[table].get(id) as Row<T> | undefined);
}

/** Rows in show order (ordered tables) or by creation time (notes, persons). */
export function useOrderedRows<T extends TableName>(table: T): Row<T>[] {
  const rows = useShowStore((s) => s.tables[table]);
  const order = useShowStore((s) =>
    isOrderedTable(table) ? s.order[table as OrderedTableName] : null,
  );
  return useMemo(() => {
    const map = rows as Map<string, Row<T>>;
    if (order) return order.map((id) => map.get(id)).filter((r): r is Row<T> => !!r);
    return [...map.values()].sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
  }, [rows, order]);
}

export function useMutate(): ShowStore["mutate"] {
  return useShowStoreInstance().mutate;
}
