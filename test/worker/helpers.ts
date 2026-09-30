// Shared helpers for worker tests: call the /api surface through the real Worker entry.
import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { CreateInviteResponse, ShowSummaryDTO } from "../../src/shared/api";
import type { ServerMessage } from "../../src/shared/ws";
import {
  INTERNAL_HEADER,
  INTERNAL_MARKER,
  type ShowDO,
  USER_ID_HEADER,
} from "../../src/worker/do/ShowDO";

export const ADMIN = { email: "admin@test.local", password: "test-password-123" };
export const ORIGIN = "http://localhost";
/** A same-origin browser WebSocket handshake (requests go to http://localhost). */
export const WS_HEADERS = { Upgrade: "websocket", Origin: ORIGIN };

export async function api(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.cookie) headers.set("Cookie", init.cookie);
  // Browsers send Origin on every non-GET fetch; the CSRF middleware relies on it.
  if (!headers.has("Origin") && init.method && init.method !== "GET") {
    headers.set("Origin", ORIGIN);
  }
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

export function post(path: string, body: unknown, cookie?: string) {
  return api(path, { method: "POST", body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });
}

export function sessionCookie(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  const pair = set.split(";")[0] ?? "";
  expect(pair).toMatch(/^cs_session=.+/);
  return pair;
}

export async function loginAdmin(): Promise<string> {
  const res = await post("/api/auth/login", ADMIN);
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

let userSeq = 0;

/** Invite + accept a fresh user; returns their cookie, id and email. */
export async function newUser(admin: string, name = "User") {
  const email = `user${Date.now().toString(36)}${userSeq++}@test.local`;
  const invite = (await (
    await post("/api/invites", { email }, admin)
  ).json()) as CreateInviteResponse;
  const token = invite.path.split("/").at(-1) as string;
  const res = await post(`/api/invites/${token}/accept`, { name, password: "long-enough-pw" });
  expect(res.status).toBe(201);
  const { user } = (await res.clone().json()) as { user: { id: string } };
  return { cookie: sessionCookie(res), id: user.id, email };
}

export async function createShow(cookie: string, name = "Show"): Promise<ShowSummaryDTO> {
  const res = await post("/api/shows", { name }, cookie);
  expect(res.status).toBe(201);
  return ((await res.json()) as { show: ShowSummaryDTO }).show;
}

/** Collects messages from a WebSocket; `next(pred)` resolves with the first match. */
export function collect(ws: WebSocket) {
  const received: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let closed: { code: number } | null = null;
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(e.data as string) as ServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code };
    for (const w of waiters.splice(0)) w();
  });
  ws.accept();
  const wait = () =>
    new Promise<void>((r) => {
      waiters.push(r);
      setTimeout(r, 50);
    });
  return {
    ws,
    received,
    async next<M extends ServerMessage>(pred: (m: ServerMessage) => m is M, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = received.findIndex(pred);
        if (i >= 0) return received.splice(0, i + 1).at(-1) as M;
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(received)}`);
        await wait();
      }
    },
    async closedWith(timeoutMs = 2000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (!closed) {
        if (Date.now() > deadline) throw new Error("socket not closed");
        await wait();
      }
      return (closed as { code: number }).code;
    },
  };
}

/** Open a WebSocket straight into a DO. */
export async function connectDO(stub: DurableObjectStub<ShowDO>, userId = "user-1") {
  const res = await stub.fetch("http://do/ws", {
    headers: { Upgrade: "websocket", [USER_ID_HEADER]: userId, [INTERNAL_HEADER]: INTERNAL_MARKER },
  });
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no webSocket on response");
  return collect(res.webSocket);
}

export const isType =
  <T extends ServerMessage["type"]>(type: T) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
    m.type === type;
