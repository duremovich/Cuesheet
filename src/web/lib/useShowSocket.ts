// One WebSocket per open show page. Reconnects with backoff after network drops; stops for
// good if the server refuses the upgrade (signed out, not a member, show gone, bad origin).
import { useEffect, useState } from "react";
import { PING_FRAME, parseServerMessage } from "../../shared/ws";
import { ApiError, api, showSocketUrl } from "./api";

export type SocketStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

export interface ShowSocketState {
  status: SocketStatus;
  clients: number;
}

const HEARTBEAT_MS = 25_000;
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

export function useShowSocket(showId: string): ShowSocketState {
  const [state, setState] = useState<ShowSocketState>({ status: "connecting", clients: 0 });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      setState((s) => ({ ...s, status: "connecting" }));
      let opened = false;
      ws = new WebSocket(showSocketUrl(showId));
      ws.onopen = () => {
        opened = true;
        heartbeat = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (e) => {
        const msg = parseServerMessage(e.data);
        if (msg?.type === "hello" || msg?.type === "presence") {
          attempt = 0;
          setState({ status: "connected", clients: msg.clients });
        }
      };
      ws.onclose = async () => {
        clearInterval(heartbeat);
        if (stopped) return;
        if (!opened && (await upgradeWasRefused(showId))) {
          if (!stopped) setState({ status: "unauthorized", clients: 0 });
          return; // terminal: retrying can't help
        }
        if (stopped) return;
        setState({ status: "disconnected", clients: 0 });
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      ws?.close(1000, "leaving show");
    };
  }, [showId]);

  return state;
}
