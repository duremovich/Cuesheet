// Messages on the per-show WebSocket (/api/shows/:id/ws).
import type { Role } from "./api";
import type { AnyResolvedOp } from "./ops";

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
  ops: AnyResolvedOp[];
}

/** Someone connected to the show (one entry per member or share link). */
export interface PresenceUser {
  /** User id, or `share:<linkId>` for a share link's visitors. */
  id: string;
  /** The member's name; share visitors are "Guest (read-only)". */
  name: string;
  /** Viewers and share links. */
  readOnly: boolean;
  /**
   * Open connections: a member's tabs and devices; for a share link, how many visitors
   * (each one counts as a guest in `people`).
   */
  connections: number;
}

/** Who's here (R22). Share links' visitors get the counts but never `users`. */
export interface PresenceCounts {
  /**
   * People here: each signed-in account once, however many tabs it has open; each share
   * link connection as one guest (visitors can't be told apart).
   */
  people: number;
  /** Open connections (tabs, devices, share visitors). */
  clients: number;
  /** How many of `people` are read-only (viewers and share links' guests). */
  readOnly?: number;
  /** Who is connected (not sent to share links' visitors). */
  users?: PresenceUser[];
}

/** Sent to a client right after it connects. */
export interface HelloMessage extends PresenceCounts {
  type: "hello";
  showId: string;
}

/** Broadcast to every client whenever someone joins or leaves (or a role changes). */
export interface PresenceMessage extends PresenceCounts {
  type: "presence";
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

/**
 * Your role in this show changed (the owner changed it). Sent to that user's sockets only;
 * the client updates what it lets you edit without a reload. Removal sends `revoked`.
 */
export interface RoleMessage {
  type: "role";
  role: Role;
}

/**
 * Show-level fields changed (PATCH /api/shows/:id): the name and the current session label
 * new notes default to. Broadcast to every socket of the show.
 */
export interface ShowMessage {
  type: "show";
  name: string;
  currentSession: string | null;
}

export type ServerMessage =
  | ShowMessage
  | RevokedMessage
  | RoleMessage
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

/**
 * How often an open page sends PING_FRAME. The ShowDO reads each socket's last heartbeat
 * (`getWebSocketAutoResponseTimestamp`) to drop connections whose page is gone.
 */
export const HEARTBEAT_MS = 25_000;

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
