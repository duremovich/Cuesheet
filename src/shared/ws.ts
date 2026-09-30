// Messages on the per-show WebSocket (/api/shows/:id/ws).
// M0 only carries presence; M1 adds record changes.

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

export type ServerMessage = HelloMessage | PresenceMessage | PongMessage;

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
