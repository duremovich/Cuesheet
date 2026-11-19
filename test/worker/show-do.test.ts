// ShowDO in the real Workers runtime: migrations, meta, and WebSocket presence
// (including after the object hibernates).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ShareScope } from "../../src/shared/share";
import { PING_FRAME, type ServerMessage } from "../../src/shared/ws";
import {
  INTERNAL_HEADER,
  INTERNAL_MARKER,
  PRESENCE_STALE_MS,
  ROLE_HEADER,
  SHARE_SCOPE_HEADER,
  type ShowDO,
  STALE_SOCKET_CODE,
  USER_ID_HEADER,
} from "../../src/worker/do/ShowDO";

function stubFor(name: string) {
  return env.SHOW.get(env.SHOW.idFromName(name));
}

/** Open a WebSocket straight into the DO and collect what it receives. */
async function connect(
  stub: DurableObjectStub<ShowDO>,
  userId = "user-1",
  extra: Record<string, string> = {},
) {
  const res = await stub.fetch("http://do/ws", {
    headers: {
      Upgrade: "websocket",
      [USER_ID_HEADER]: userId,
      [INTERNAL_HEADER]: INTERNAL_MARKER,
      ...extra,
    },
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
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
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
  return { ws, next, closed };
}

/** A share link's visitor, straight into the DO (the Worker sends the link's scope). */
function connectShare(stub: DurableObjectStub<ShowDO>, showId: string, linkId: string) {
  const scope: ShareScope = {
    linkId,
    showId,
    tables: ["cues"],
    attachmentTables: [],
    viewId: null,
    viewTable: null,
    fullPersons: false,
    notes: null,
    expiresAt: null,
  };
  return connect(stub, "ignored", { [SHARE_SCOPE_HEADER]: JSON.stringify(scope) });
}

/** Inside the DO: make every open socket look connected `ageMs` ago (and never pinged). */
function ageSockets(stub: DurableObjectStub<ShowDO>, ageMs: number) {
  return runInDurableObject(stub, (_i, state) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown>;
      ws.serializeAttachment({ ...att, connectedAt: Date.now() - ageMs });
    }
  });
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
      people: 1,
      readOnly: 0,
      users: [{ id: "alice", name: "Someone", readOnly: false, connections: 1 }],
    });

    const b = await connect(stub, "bob");
    expect(await b.next((m) => m.type === "hello")).toMatchObject({ clients: 2 });
    expect(await a.next((m) => m.type === "presence")).toEqual({
      type: "presence",
      clients: 2,
      people: 2,
      readOnly: 0,
      users: [
        { id: "alice", name: "Someone", readOnly: false, connections: 1 },
        { id: "bob", name: "Someone", readOnly: false, connections: 1 },
      ],
    });
    expect(await stub.clientCount()).toBe(2);

    b.ws.send(PING_FRAME);
    expect(await b.next((m) => m.type === "pong")).toEqual({ type: "pong" });

    b.ws.close(1000, "bye");
    expect(await a.next((m) => m.type === "presence" && m.clients === 1)).toEqual({
      type: "presence",
      clients: 1,
      people: 1,
      readOnly: 0,
      users: [{ id: "alice", name: "Someone", readOnly: false, connections: 1 }],
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

describe("ShowDO presence: people, not connections", () => {
  it("counts an account once however many tabs it has, and each share visitor as a guest", async () => {
    const stub = stubFor("show-people");
    await stub.sync("show-people", "People show");
    const a1 = await connect(stub, "alice");
    await a1.next((m) => m.type === "hello");
    const a2 = await connect(stub, "alice");
    const v1 = await connect(stub, "vic", { [ROLE_HEADER]: "viewer" });
    const v2 = await connect(stub, "vic", { [ROLE_HEADER]: "viewer" });
    const g1 = await connectShare(stub, "show-people", "L1");
    const g2 = await connectShare(stub, "show-people", "L1");
    // Six connections: Alice (2 tabs), Vic the viewer (2 tabs), two visitors of one link.
    expect(await a1.next((m) => m.type === "presence" && m.clients === 6)).toEqual({
      type: "presence",
      clients: 6,
      people: 4,
      readOnly: 3,
      users: [
        { id: "alice", name: "Someone", readOnly: false, connections: 2 },
        { id: "vic", name: "Someone", readOnly: true, connections: 2 },
        { id: "share:L1", name: "Guest (read-only)", readOnly: true, connections: 2 },
      ],
    });
    // A visitor gets the counts, never names or per-person details.
    expect(await g2.next((m) => m.type === "hello")).toEqual({
      type: "hello",
      showId: "show-people",
      clients: 6,
      people: 4,
      readOnly: 3,
    });
    // One of Alice's tabs closes: still one person.
    a2.ws.close(1000, "bye");
    expect(await a1.next((m) => m.type === "presence" && m.clients === 5)).toMatchObject({
      people: 4,
      users: [{ id: "alice", connections: 1 }, { id: "vic" }, { id: "share:L1" }],
    });
    // A visitor leaves: one guest fewer.
    g1.ws.close(1000, "bye");
    expect(await a1.next((m) => m.type === "presence" && m.clients === 4)).toMatchObject({
      people: 3,
      readOnly: 2,
    });
    for (const x of [a1, v1, v2, g2]) x.ws.close(1000, "bye");
  });

  it("drops and closes connections whose heartbeat stopped (a reload whose close never came)", async () => {
    const stub = stubFor("show-stale");
    await stub.sync("show-stale", "Stale show");
    const ghost = await connect(stub, "alice");
    await ghost.next((m) => m.type === "hello");
    const live = await connect(stub, "alice");
    await live.next((m) => m.type === "hello");
    // Both connected long ago; only `live` kept up its heartbeat (the runtime's
    // auto-response timestamp), the ghost went silent.
    await ageSockets(stub, PRESENCE_STALE_MS + 30_000);
    live.ws.send(PING_FRAME);
    await live.next((m) => m.type === "pong");

    const bob = await connect(stub, "bob");
    expect(await bob.next((m) => m.type === "hello")).toMatchObject({
      clients: 2,
      people: 2,
      users: [
        { id: "alice", connections: 1 },
        { id: "bob", connections: 1 },
      ],
    });
    expect(await ghost.closed).toBe(STALE_SOCKET_CODE);
    expect(await stub.clientCount()).toBe(2);
    for (const x of [live, bob]) x.ws.close(1000, "bye");
  });

  it("a connection isn't stale before its first heartbeat is due", async () => {
    const stub = stubFor("show-fresh");
    await stub.sync("show-fresh", "Fresh show");
    const a = await connect(stub, "alice");
    await a.next((m) => m.type === "hello");
    await ageSockets(stub, PRESENCE_STALE_MS - 10_000);
    const b = await connect(stub, "bob");
    expect(await b.next((m) => m.type === "hello")).toMatchObject({ clients: 2, people: 2 });
    for (const x of [a, b]) x.ws.close(1000, "bye");
  });

  it("each new connection schedules a sweep, which clears the ghost a reload leaves", async () => {
    const stub = stubFor("show-sweep");
    await stub.sync("show-sweep", "Sweep show");
    const ghost = await connect(stub, "alice");
    await ghost.next((m) => m.type === "hello");
    const before = Date.now();
    const reloaded = await connect(stub, "alice");
    await reloaded.next((m) => m.type === "hello");
    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + PRESENCE_STALE_MS);

    // Time passes: the reloaded page keeps pinging, the ghost doesn't.
    await ageSockets(stub, PRESENCE_STALE_MS + 30_000);
    reloaded.ws.send(PING_FRAME);
    await reloaded.next((m) => m.type === "pong");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await reloaded.next((m) => m.type === "presence")).toMatchObject({
      clients: 1,
      people: 1,
      users: [{ id: "alice", connections: 1 }],
    });
    expect(await ghost.closed).toBe(STALE_SOCKET_CODE);
    // The alarm ran early (tests can make it): it's set again for the latest connect's sweep.
    const due = await runInDurableObject(stub, (_i, s) =>
      s.storage.get<number>("presence:sweepAt"),
    );
    expect(due).toBeGreaterThanOrEqual(before + PRESENCE_STALE_MS);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBe(due);
    // Once it has run on time it's done: a one-off, no alarm left behind.
    await runInDurableObject(stub, (_i, s) => s.storage.put("presence:sweepAt", Date.now() - 1));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
    reloaded.ws.close(1000, "bye");
  });
});
