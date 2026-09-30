// ShowDO in the real Workers runtime: migrations, meta, and WebSocket presence
// (including after the object hibernates).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PING_FRAME, type ServerMessage } from "../../src/shared/ws";
import {
  INTERNAL_HEADER,
  INTERNAL_MARKER,
  type ShowDO,
  USER_ID_HEADER,
} from "../../src/worker/do/ShowDO";

function stubFor(name: string) {
  return env.SHOW.get(env.SHOW.idFromName(name));
}

/** Open a WebSocket straight into the DO and collect what it receives. */
async function connect(stub: DurableObjectStub<ShowDO>, userId = "user-1") {
  const res = await stub.fetch("http://do/ws", {
    headers: { Upgrade: "websocket", [USER_ID_HEADER]: userId, [INTERNAL_HEADER]: INTERNAL_MARKER },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  const received: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(e.data as string) as ServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  ws.accept();
  /** Resolve with the first received message (from now on) matching `pred`. */
  async function next(pred: (m: ServerMessage) => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = received.findIndex(pred);
      if (i >= 0) return received.splice(0, i + 1).at(-1) as ServerMessage;
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(received)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  return { ws, next };
}

describe("ShowDO", () => {
  it("applies its migrations and caches meta, refreshing the name on sync", async () => {
    const stub = stubFor("show-meta");
    expect(await stub.getMeta()).toBeNull();
    const meta = await stub.sync("show-meta", "Some Like It Hot");
    expect(meta).toMatchObject({ showId: "show-meta", name: "Some Like It Hot" });
    // Syncing again with the same name is a no-op.
    expect(await stub.sync("show-meta", "Some Like It Hot")).toEqual(meta);
    // A new name (D1 is the source of truth) refreshes the cache; createdAt is kept.
    const renamed = await stub.sync("show-meta", "Some Like It Hotter");
    expect(renamed).toEqual({ ...meta, name: "Some Like It Hotter" });
    expect(await stub.getMeta()).toEqual(renamed);

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name),
    );
    expect(tables).toContain("meta");
    expect(tables).toContain("__drizzle_migrations");
  });

  it("rejects non-WebSocket requests and sockets for an uninitialised show", async () => {
    const stub = stubFor("show-empty");
    expect((await stub.fetch("http://do/")).status).toBe(426);
    const res = await stub.fetch("http://do/ws", {
      headers: { Upgrade: "websocket", [USER_ID_HEADER]: "u", [INTERNAL_HEADER]: INTERNAL_MARKER },
    });
    expect(res.status).toBe(404);
  });

  it("says hello and broadcasts presence as clients join and leave", async () => {
    const stub = stubFor("show-ws");
    await stub.sync("show-ws", "WS show");

    const a = await connect(stub, "alice");
    expect(await a.next((m) => m.type === "hello")).toEqual({
      type: "hello",
      showId: "show-ws",
      clients: 1,
      readOnly: 0,
      users: [{ id: "alice", name: "Someone", readOnly: false }],
    });

    const b = await connect(stub, "bob");
    expect(await b.next((m) => m.type === "hello")).toMatchObject({ clients: 2 });
    expect(await a.next((m) => m.type === "presence")).toEqual({
      type: "presence",
      clients: 2,
      readOnly: 0,
      users: [
        { id: "alice", name: "Someone", readOnly: false },
        { id: "bob", name: "Someone", readOnly: false },
      ],
    });
    expect(await stub.clientCount()).toBe(2);

    b.ws.send(PING_FRAME);
    expect(await b.next((m) => m.type === "pong")).toEqual({ type: "pong" });

    b.ws.close(1000, "bye");
    expect(await a.next((m) => m.type === "presence" && m.clients === 1)).toEqual({
      type: "presence",
      clients: 1,
      readOnly: 0,
      users: [{ id: "alice", name: "Someone", readOnly: false }],
    });
    a.ws.close(1000, "bye");
  });

  it("keeps sockets and presence across hibernation", async () => {
    const stub = stubFor("show-hibernate");
    await stub.sync("show-hibernate", "Hibernating show");
    const a = await connect(stub, "alice");
    await a.next((m) => m.type === "hello");
    const b = await connect(stub, "bob");
    await a.next((m) => m.type === "presence" && m.clients === 2);

    await evictDurableObject(stub); // hibernates sockets, drops in-memory state

    // Heartbeats are answered by the runtime's auto-response while hibernated.
    a.ws.send(PING_FRAME);
    expect(await a.next((m) => m.type === "pong")).toEqual({ type: "pong" });

    b.ws.close(1000, "bye");
    expect(await a.next((m) => m.type === "presence" && m.clients === 1)).toMatchObject({
      clients: 1,
    });
    expect(await stub.getMeta()).toMatchObject({ name: "Hibernating show" });
    a.ws.close(1000, "bye");
  });
});
