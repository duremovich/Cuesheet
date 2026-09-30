// One Durable Object per show (SQLite-backed). It owns the show's tables and its live
// WebSocket connections. The Worker has already checked auth and membership before
// calling in here; the DO trusts its caller.
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { Role, ShowMetaDTO } from "../../shared/api";
import type { HistoryEntry, MutateResponse, SnapshotResponse } from "../../shared/ops";
import { type FieldOptions, TABLE_NAMES } from "../../shared/tables";
import { PING_FRAME, PONG_FRAME, type ServerMessage } from "../../shared/ws";
import migrations from "../db/do/migrations/migrations.js";
import * as schema from "../db/do/schema";
import {
  Batch,
  currentVersion,
  type HistoryQuery,
  loadFieldOptions,
  type MutationContext,
  OpError,
  readHistory,
  readSnapshot,
} from "./ops-engine";

/** Header the Worker uses to tell the DO who opened a WebSocket. */
export const USER_ID_HEADER = "X-Cuesheet-User";

/** Close code sent to sockets whose user lost access (logout, removed from the show). */
export const ACCESS_REVOKED_CODE = 4003;

/**
 * Broadcasts bigger than this (256 KiB of UTF-8) send `{type:"version"}` instead of the
 * ops; clients then refetch the snapshot. Keeps imports from pushing megabytes through
 * every socket.
 */
const MAX_BROADCAST_BYTES = 256 * 1024;

export type MutateResult =
  | ({ ok: true } & MutateResponse)
  | { ok: false; status: 400 | 403; error: string; opIndex?: number };

interface SocketAttachment {
  userId: string;
}

export class ShowDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
    // Answer client heartbeats in the runtime so they don't wake a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
    // Nothing else runs until migrations have been applied.
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  // ---- RPC (called by the Worker via the stub) ----

  /**
   * Create or refresh the show's meta row. D1 `shows.name` is the source of truth; `meta`
   * is a cache the Worker refreshes whenever the show is created or opened.
   */
  async sync(showId: string, name: string): Promise<ShowMetaDTO> {
    const existing = await this.getMeta();
    if (!existing) {
      const row = { id: 1, showId, name, createdAt: Date.now() };
      await this.db.insert(schema.meta).values(row);
      return { showId, name, createdAt: row.createdAt };
    }
    if (existing.name !== name) {
      await this.db.update(schema.meta).set({ name }).where(eq(schema.meta.id, 1));
    }
    return { ...existing, name };
  }

  async getMeta(): Promise<ShowMetaDTO | null> {
    const row = await this.db.select().from(schema.meta).where(eq(schema.meta.id, 1)).get();
    return row ? { showId: row.showId, name: row.name, createdAt: row.createdAt } : null;
  }

  /** Number of open WebSocket connections (for tests and diagnostics). */
  async clientCount(): Promise<number> {
    return this.openSockets().length;
  }

  /**
   * Apply a batch of ops atomically, then broadcast the resolved ops. The Worker has
   * checked membership and passes the caller's role; the op engine enforces what each
   * role may do. Errors come back as values (not thrown) so the Worker can map them to
   * HTTP statuses.
   */
  async mutate(ctx: MutationContext, ops: unknown): Promise<MutateResult> {
    let result: MutateResponse;
    try {
      result = this.ctx.storage.transactionSync(() =>
        new Batch(this.ctx.storage.sql, ctx).run(ops),
      );
    } catch (e) {
      if (e instanceof OpError) {
        return {
          ok: false,
          status: e.status,
          error: e.message,
          ...(e.opIndex !== undefined ? { opIndex: e.opIndex } : {}),
        };
      }
      throw e;
    }
    if (result.version !== result.prevVersion) {
      const msg: ServerMessage = {
        type: "ops",
        prevVersion: result.prevVersion,
        version: result.version,
        clientId: ctx.clientId ?? "",
        ops: result.ops,
      };
      const text = JSON.stringify(msg);
      if (new TextEncoder().encode(text).byteLength <= MAX_BROADCAST_BYTES) {
        this.broadcastRaw(text);
      } else this.broadcast({ type: "version", version: result.version });
    }
    return { ok: true, ...result };
  }

  /**
   * The whole show as a JSON string (a SnapshotResponse). Serialised here so the Worker
   * passes it straight through instead of structured-cloning and re-encoding it.
   */
  async snapshotJson(): Promise<string> {
    return JSON.stringify(readSnapshot(this.ctx.storage.sql) satisfies SnapshotResponse);
  }

  async history(query: HistoryQuery): Promise<HistoryEntry[]> {
    return readHistory(this.ctx.storage.sql, query);
  }

  async fieldOptions(): Promise<FieldOptions> {
    return loadFieldOptions(this.ctx.storage.sql);
  }

  async version(): Promise<number> {
    return currentVersion(this.ctx.storage.sql);
  }

  /** True when any core table has rows (import refuses to run into a non-empty show). */
  async hasData(): Promise<boolean> {
    return TABLE_NAMES.some(
      (t) => this.ctx.storage.sql.exec(`SELECT 1 FROM "${t}" LIMIT 1`).toArray().length > 0,
    );
  }

  /**
   * Close every socket belonging to a user (logout, removal from the show). Each gets a
   * `revoked` message first so the client stops reconnecting instead of retrying.
   */
  /** Tell a user's open sockets their role changed (`{type:"role"}`). Returns how many. */
  async notifyRole(userId: string, role: Role): Promise<number> {
    const sockets = this.ctx.getWebSockets(userId);
    for (const ws of sockets) this.send(ws, { type: "role", role });
    return sockets.length;
  }

  /**
   * Show-level fields changed in D1 (name, current session): tell every open socket
   * (`{type:"show"}`). Nothing is stored here; D1 is the source of truth and the meta name
   * refreshes when the show is opened. Returns how many sockets were told.
   */
  async notifyShow(show: { name: string; currentSession: string | null }): Promise<number> {
    const n = this.openSockets().length;
    this.broadcast({ type: "show", name: show.name, currentSession: show.currentSession });
    return n;
  }

  async disconnectUser(userId: string): Promise<number> {
    const sockets = this.ctx.getWebSockets(userId);
    for (const ws of sockets) {
      this.send(ws, { type: "revoked" });
      try {
        ws.close(ACCESS_REVOKED_CODE, "access revoked");
      } catch {
        // already closed
      }
    }
    if (sockets.length > 0) this.onDisconnect(...sockets);
    return sockets.length;
  }

  // ---- WebSocket (Hibernation API) ----

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get(USER_ID_HEADER);
    if (!userId) return new Response("Missing user", { status: 400 });
    const meta = await this.getMeta();
    if (!meta) return new Response("Show not initialised", { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId } satisfies SocketAttachment);

    const clients = this.openSockets().length;
    this.send(server, { type: "hello", showId: meta.showId, clients });
    // Lets the client notice changes it missed while disconnected (and refetch).
    this.send(server, { type: "version", version: currentVersion(this.ctx.storage.sql) });
    this.broadcast({ type: "presence", clients }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Heartbeat pings never get here: the runtime answers PING_FRAME with PONG_FRAME
    // without waking the object (see the constructor). Edits arrive over HTTP
    // (POST /mutate → mutate()), not the socket; the socket only carries broadcasts.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.onDisconnect(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onDisconnect(ws);
  }

  private onDisconnect(...gone: WebSocket[]): void {
    const remaining = this.openSockets().filter((ws) => !gone.includes(ws));
    for (const ws of remaining) this.send(ws, { type: "presence", clients: remaining.length });
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    for (const ws of this.openSockets()) if (ws !== except) this.send(ws, msg);
  }

  /** Broadcast an already-serialised message to every open socket. */
  private broadcastRaw(text: string): void {
    for (const ws of this.openSockets()) {
      try {
        ws.send(text);
      } catch {
        // closing; its close handler updates presence
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket went away between listing and sending; its close handler will update presence.
    }
  }
}
