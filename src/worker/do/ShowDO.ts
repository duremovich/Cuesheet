// One Durable Object per show (SQLite-backed). It owns the show's tables and its live
// WebSocket connections. The Worker has already checked auth and membership before
// calling in here; the DO trusts its caller.
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { ShowMetaDTO } from "../../shared/api";
import type { ClientMessage, ServerMessage } from "../../shared/ws";
import migrations from "../db/do/migrations/migrations.js";
import * as schema from "../db/do/schema";

/** Header the Worker uses to tell the DO who opened a WebSocket. */
export const USER_ID_HEADER = "X-Cuesheet-User";

interface SocketAttachment {
  userId: string;
}

export class ShowDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
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
    this.broadcast({ type: "presence", clients }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "ping") this.send(ws, { type: "pong" });
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

  private onDisconnect(gone: WebSocket): void {
    const remaining = this.openSockets().filter((ws) => ws !== gone);
    for (const ws of remaining) this.send(ws, { type: "presence", clients: remaining.length });
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    for (const ws of this.openSockets()) if (ws !== except) this.send(ws, msg);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket went away between listing and sending; its close handler will update presence.
    }
  }
}
