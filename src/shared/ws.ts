// Messages on the per-show WebSocket (/api/shows/:id/ws).
import type { ResolvedOp } from "./ops";

/**
 * Sent right after hello, and broadcast instead of `ops` when a batch is too large to send
 * (e.g. an import). A client whose version is lower refetches the snapshot.
 */
export interface VersionMessage {
  type: "version";
  version: number;
}

/** A committed batch of resolved ops. Apply only if `prevVersion` equals your version. */
export interface OpsMessage {
  type: "ops";
  prevVersion: number;
  version: number;
  /** The sender's store id (so it can recognise its own batch). */
  clientId: string;
  ops: ResolvedOp[];
}

/** Sent to a client right after it connects. */
export interface HelloMessage {
  type: "hello";
  showId: string;
  clients: number;
}

/** Broadcast to every client whenever someone joins or leaves. */
export interface PresenceMessage {
  type: "presence";
  clients: number;
}

export interface PongMessage {
  type: "pong";
}

/**
 * Sent just before the server closes the socket because the user lost access (logout,
 * removed from the show). Terminal: the client must not reconnect.
 */
export interface RevokedMessage {
  type: "revoked";
}

export type ServerMessage =
  | RevokedMessage
  | HelloMessage
  | PresenceMessage
  | VersionMessage
  | OpsMessage
  | PongMessage;

export interface PingMessage {
  type: "ping";
}

export type ClientMessage = PingMessage;

/**
 * Exact heartbeat frames. The ShowDO registers these with `setWebSocketAutoResponse`, which
 * matches the request byte-for-byte, so clients must send PING_FRAME verbatim.
 */
export const PING_FRAME = JSON.stringify({ type: "ping" } satisfies PingMessage);
export const PONG_FRAME = JSON.stringify({ type: "pong" } satisfies PongMessage);

export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const msg = JSON.parse(data) as { type?: unknown };
    if (msg && typeof msg === "object" && typeof msg.type === "string") {
      return msg as ServerMessage;
    }
  } catch {
    // fall through
  }
  return null;
}
