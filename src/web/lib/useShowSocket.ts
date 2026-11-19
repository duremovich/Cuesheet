// One WebSocket per open show page. Reconnects with backoff after network drops; stops for
// good if the server refuses the upgrade (signed out, not a member, show gone, bad origin).
// Closes on pagehide (reload, navigation) and reconnects if the page comes back from the
// back/forward cache.
import { useEffect, useRef, useState } from "react";
import {
  HEARTBEAT_MS,
  PING_FRAME,
  type PresenceUser,
  parseServerMessage,
  type ServerMessage,
} from "../../shared/ws";
import { ApiError, api, showSocketUrl } from "./api";

export type SocketStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

export interface ShowSocketState {
  status: SocketStatus;
  /** People here: an account once however many tabs it has; each share visitor a guest. */
  people: number;
  /** Open connections (tabs, devices, share visitors). */
  clients: number;
  /** How many of `people` are read-only (viewers, share links' guests). */
  readOnly?: number;
  /** Who is connected (members see names; share visitors don't get this). */
  users?: PresenceUser[];
}

const MAX_BACKOFF_MS = 10_000;
const REFUSED = new Set([401, 403, 404]);

/**
 * Browsers hide the HTTP status of a refused WebSocket upgrade (it's just close code 1006,
 * same as a network drop). When a socket closes without ever opening, ask the API whether
 * we may see the show: 401/403/404 means "refused" (terminal); anything else, retry.
 */
async function upgradeWasRefused(showId: string): Promise<boolean> {
  try {
    await api.getShow(showId);
    return false;
  } catch (e) {
    return e instanceof ApiError && REFUSED.has(e.status);
  }
}

/**
 * `onMessage` receives every server message (the show store feeds on `ops`/`version`).
 * It's read through a ref, so passing a new function doesn't reconnect.
 */
export function useShowSocket(
  showId: string,
  onMessage?: (msg: ServerMessage) => void,
): ShowSocketState {
  const [state, setState] = useState<ShowSocketState>({
    status: "connecting",
    people: 0,
    clients: 0,
  });
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    /** The page is going away or sits in the back/forward cache: no reconnecting. */
    let hidden = false;

    const connect = () => {
      setState((s) => ({ ...s, status: "connecting" }));
      let opened = false;
      const sock = new WebSocket(showSocketUrl(showId));
      ws = sock;
      ws.onopen = () => {
        opened = true;
        heartbeat = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (e) => {
        const msg = parseServerMessage(e.data);
        if (msg) onMessageRef.current?.(msg);
        if (msg?.type === "revoked") {
          // Access was taken away (removed from the show, signed out): terminal.
          stopped = true;
          clearInterval(heartbeat);
          setState({ status: "unauthorized", people: 0, clients: 0 });
          ws?.close(1000, "revoked");
          return;
        }
        if (msg?.type === "hello" || msg?.type === "presence") {
          attempt = 0;
          setState({
            status: "connected",
            people: msg.people,
            clients: msg.clients,
            readOnly: msg.readOnly ?? 0,
            users: msg.users ?? [],
          });
        }
      };
      ws.onclose = async () => {
        // A socket closed on pagehide may report in only after pageshow opened a new one.
        if (sock !== ws) return;
        clearInterval(heartbeat);
        if (stopped || hidden) return;
        if (!opened && (await upgradeWasRefused(showId))) {
          if (!stopped) setState({ status: "unauthorized", people: 0, clients: 0 });
          return; // terminal: retrying can't help
        }
        if (stopped || hidden) return;
        setState({ status: "disconnected", people: 0, clients: 0 });
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    // A reload or navigation doesn't run React cleanup: close the socket ourselves, so the
    // server hears a close now instead of keeping a ghost connection until it notices the
    // page is gone (the ShowDO also drops sockets whose heartbeat stopped). A page restored
    // from the back/forward cache reconnects.
    const onPageHide = () => {
      hidden = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      ws?.close(1000, "page hidden");
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || !hidden || stopped) return;
      hidden = false;
      attempt = 0;
      connect();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    connect();
    return () => {
      stopped = true;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      ws?.close(1000, "leaving show");
    };
  }, [showId]);

  return state;
}
