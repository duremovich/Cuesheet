// One WebSocket per open show page. Reconnects with backoff; exposes connection status
// and the presence count the ShowDO broadcasts.
import { useEffect, useState } from "react";
import { type ClientMessage, parseServerMessage } from "../../shared/ws";
import { showSocketUrl } from "./api";

export type SocketStatus = "connecting" | "connected" | "disconnected";

export interface ShowSocketState {
  status: SocketStatus;
  clients: number;
}

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 10_000;

export function useShowSocket(showId: string): ShowSocketState {
  const [state, setState] = useState<ShowSocketState>({ status: "connecting", clients: 0 });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const send = (msg: ClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const connect = () => {
      setState((s) => ({ ...s, status: "connecting" }));
      ws = new WebSocket(showSocketUrl(showId));
      ws.onmessage = (e) => {
        const msg = parseServerMessage(e.data);
        if (!msg) return;
        if (msg.type === "hello" || msg.type === "presence") {
          attempt = 0;
          setState({ status: "connected", clients: msg.clients });
        }
      };
      ws.onopen = () => {
        heartbeat = setInterval(() => send({ type: "ping" }), HEARTBEAT_MS);
      };
      ws.onclose = () => {
        clearInterval(heartbeat);
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
