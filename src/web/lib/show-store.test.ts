import { describe, expect, it, vi } from "vitest";
import type { MutateRequest, MutateResponse, Op, SnapshotResponse } from "../../shared/ops";
import type { AnyRow, TableName } from "../../shared/tables";
import { ORDERED_TABLES, TABLE_NAMES } from "../../shared/tables";
import type { OpsMessage } from "../../shared/ws";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "./show-state";
import { ShowStoreImpl, type ShowTransport } from "./show-store";

/** A tiny in-memory stand-in for the ShowDO, built on the same shared logic. */
class FakeServer {
  data: ShowData = emptyData();
  now = 5000;
  snapshotCalls = 0;

  apply(req: MutateRequest): MutateResponse {
    const prevVersion = this.data.version;
    const ops = resolveLocal(this.data, req.ops, { userId: "server", now: this.now++ });
    // One version per resolved op (the real server uses one per changed field).
    this.data = { ...applyResolved(this.data, ops), version: prevVersion + ops.length };
    return { prevVersion, version: this.data.version, ops };
  }

  snapshot(): SnapshotResponse {
    this.snapshotCalls++;
    const tables = {} as Record<TableName, AnyRow[]>;
    for (const t of TABLE_NAMES) {
      const map = this.data.tables[t] as Map<string, AnyRow>;
      tables[t] = (ORDERED_TABLES as readonly string[]).includes(t)
        ? this.data.order[t as "cues"].map((id) => map.get(id) as AnyRow)
        : [...map.values()];
    }
    const joins = {} as SnapshotResponse["joins"];
    for (const [k, m] of Object.entries(this.data.joins)) {
      joins[k as keyof SnapshotResponse["joins"]] = Object.fromEntries(m);
    }
    return {
      version: this.data.version,
      tables: tables as SnapshotResponse["tables"],
      joins,
      fieldOptions: {},
      meta: this.data.meta,
    };
  }

  /** The broadcast the real server would send for a response. */
  message(res: MutateResponse, clientId: string): OpsMessage {
    return {
      type: "ops",
      prevVersion: res.prevVersion,
      version: res.version,
      clientId,
      ops: res.ops,
    };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A transport whose mutate calls wait until the test releases them. */
function setup() {
  const server = new FakeServer();
  const calls: { req: MutateRequest; d: Deferred<MutateResponse> }[] = [];
  const transport: ShowTransport = {
    snapshot: vi.fn(async () => server.snapshot()),
    mutate: (req) => {
      const d = deferred<MutateResponse>();
      calls.push({ req, d });
      return d.promise;
    },
  };
  const store = new ShowStoreImpl(transport, { clientId: "me", userId: "u1", now: () => 1 });
  /** Let the server apply the next queued request and answer it. */
  const releaseNext = async () => {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const call = calls.shift() as (typeof calls)[number];
    const res = server.apply(call.req);
    call.d.resolve(res);
    return res;
  };
  return { server, store, calls, releaseNext };
}

const cue = (id: string, number: string, placement: object = {}): Op => ({
  op: "create",
  table: "cues",
  id,
  fields: { number },
  ...placement,
});

const numbers = (store: ShowStoreImpl) =>
  store.order.cues.map((id) => store.tables.cues.get(id)?.number);

describe("ShowStore", () => {
  it("loads the snapshot", async () => {
    const { server, store } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1"), cue("c2", "2")] });
    expect(store.status).toBe("loading");
    await store.load();
    expect(store.status).toBe("ready");
    expect(store.version).toBe(2);
    expect(numbers(store)).toEqual(["1", "2"]);
  });

  it("applies optimistically at the right position, then confirms", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1"), cue("c3", "3")] });
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);

    const done = store.mutate([cue("c2", "2", { after: "c1" })]);
    // Visible immediately, between its neighbours, before the server answers.
    expect(numbers(store)).toEqual(["1", "2", "3"]);
    expect(store.tables.cues.get("c2")).toMatchObject({ created_by: "u1", is_section: false });
    expect(listener).toHaveBeenCalled();
    expect(store.version).toBe(2);

    await releaseNext();
    await done;
    expect(numbers(store)).toEqual(["1", "2", "3"]);
    expect(store.version).toBe(3);
    // Now the server's copy (server timestamps), not the local one.
    expect(store.tables.cues.get("c2")?.created_by).toBe("server");
  });

  it("says which rows still have unconfirmed local changes (hasPending)", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1")] });
    await store.load();
    expect(store.hasPending("cues", "c1")).toBe(false);

    const done = store.mutate([
      { op: "update", table: "cues", id: "c1", fields: { description: "x" } },
    ]);
    expect(store.hasPending("cues", "c1")).toBe(true);
    expect(store.hasPending("cues", "c2")).toBe(false);
    expect(store.hasPending("scenes", "c1")).toBe(false);
    await releaseNext();
    await done;
    expect(store.hasPending("cues", "c1")).toBe(false);
  });

  it("reconciles with the server's order when someone else inserted first", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1"), cue("c3", "3")] });
    await store.load();
    const done = store.mutate([cue("mine", "2", { after: "c1" })]);
    // Another client inserts at the same spot first; we get their broadcast.
    const theirs = server.apply({
      clientId: "other",
      ops: [cue("theirs", "1.5", { after: "c1" })],
    });
    store.handleServerMessage(server.message(theirs, "other"));
    expect(numbers(store)).toContain("1.5");
    const res = await releaseNext();
    await done;
    store.handleServerMessage(server.message(res, "me")); // our echo: already applied
    // "after c1" puts ours right after c1, i.e. before theirs.
    expect(numbers(store)).toEqual(["1", "2", "1.5", "3"]);
    expect(store.version).toBe(server.data.version);
    expect(store.order.cues).toEqual(server.data.order.cues);
  });

  it("rolls back and rethrows when the server rejects the batch", async () => {
    const { server, store, calls } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1")] });
    await store.load();
    const done = store.mutate([
      { op: "update", table: "cues", id: "c1", fields: { number: "9" } },
      cue("c2", "2"),
    ]);
    expect(numbers(store)).toEqual(["9", "2"]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]?.d.reject(new Error("status: not an option"));
    await expect(done).rejects.toThrow("not an option");
    expect(numbers(store)).toEqual(["1"]);
  });

  it("rejects locally impossible ops without sending", async () => {
    const { store, calls } = setup();
    await store.load();
    await expect(
      store.mutate([{ op: "update", table: "cues", id: "missing", fields: {} }]),
    ).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });

  it("sends batches one at a time, in order", async () => {
    const { store, calls, releaseNext } = setup();
    await store.load();
    const a = store.mutate([cue("c1", "1")]);
    const b = store.mutate([{ op: "update", table: "cues", id: "c1", fields: { number: "1.0" } }]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(numbers(store)).toEqual(["1.0"]);
    await releaseNext();
    await a;
    await releaseNext();
    await b;
    expect(numbers(store)).toEqual(["1.0"]);
    expect(store.version).toBe(2);
  });

  it("handles its own echo arriving before the HTTP response", async () => {
    const { server, store, calls } = setup();
    await store.load();
    const done = store.mutate([cue("c1", "1")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls.shift() as (typeof calls)[number];
    const res = server.apply(call.req);
    store.handleServerMessage(server.message(res, "me"));
    expect(store.version).toBe(1);
    call.d.resolve(res);
    await done;
    expect(numbers(store)).toEqual(["1"]);
    expect(store.version).toBe(1);
  });

  it("applies other clients' ops and refetches on a version gap", async () => {
    const { server, store, releaseNext } = setup();
    await store.load();
    const r1 = server.apply({ clientId: "other", ops: [cue("c1", "1")] });
    store.handleServerMessage(server.message(r1, "other"));
    expect(numbers(store)).toEqual(["1"]);
    expect(server.snapshotCalls).toBe(1);

    // We miss r2 and then see r3: gap → snapshot.
    server.apply({ clientId: "other", ops: [cue("c2", "2")] });
    const r3 = server.apply({ clientId: "other", ops: [cue("c3", "3")] });
    store.handleServerMessage(server.message(r3, "other"));
    await vi.waitFor(() => expect(numbers(store)).toEqual(["1", "2", "3"]));
    expect(server.snapshotCalls).toBe(2);

    // A version announcement ahead of us (reconnect, or a big import) → snapshot.
    server.apply({ clientId: "other", ops: [cue("c4", "4")] });
    store.handleServerMessage({ type: "version", version: server.data.version });
    await vi.waitFor(() => expect(numbers(store)).toEqual(["1", "2", "3", "4"]));
    // Same version → nothing.
    store.handleServerMessage({ type: "version", version: server.data.version });
    expect(server.snapshotCalls).toBe(3);

    // Pending local ops survive a refetch.
    const done = store.mutate([cue("c5", "5")]);
    server.apply({ clientId: "other", ops: [cue("c0", "0", { after: null })] });
    store.handleServerMessage({ type: "version", version: server.data.version });
    await vi.waitFor(() => expect(numbers(store)).toEqual(["0", "1", "2", "3", "4", "5"]));
    await releaseNext();
    await done;
    expect(numbers(store)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(store.version).toBe(server.data.version);
  });

  it("buffers messages that arrive while the snapshot loads", async () => {
    const server = new FakeServer();
    const snap = deferred<SnapshotResponse>();
    const store = new ShowStoreImpl({
      snapshot: () => snap.promise,
      mutate: async () => ({}) as never,
    });
    const loading = store.load();
    const r1 = server.apply({ clientId: "x", ops: [cue("c1", "1")] });
    const atV1 = server.snapshot();
    const r2 = server.apply({ clientId: "x", ops: [cue("c2", "2")] });
    store.handleServerMessage(server.message(r1, "x"));
    store.handleServerMessage(server.message(r2, "x"));
    snap.resolve(atV1);
    await loading;
    expect(numbers(store)).toEqual(["1", "2"]);
    expect(store.version).toBe(2);
  });

  it("cascades deletes locally like the server", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({
      clientId: "x",
      ops: [
        { op: "create", table: "scenes", id: "s1", fields: { name: "S" } },
        { op: "create", table: "persons", id: "p1", fields: { name: "P" } },
        cue("c1", "1"),
        { op: "update", table: "cues", id: "c1", fields: { scene_id: "s1" } },
        { op: "link", table: "cues", id: "c1", field: "assignees", targetId: "p1" },
      ],
    });
    await store.load();
    expect(store.joins.cueAssignees.get("c1")).toEqual(["p1"]);
    const done = store.mutate([
      { op: "delete", table: "scenes", id: "s1" },
      { op: "delete", table: "persons", id: "p1" },
    ]);
    expect(store.tables.cues.get("c1")?.scene_id).toBeNull();
    expect(store.joins.cueAssignees.has("c1")).toBe(false);
    expect(store.order.scenes).toEqual([]);
    await releaseNext();
    await done;
    expect(store.tables.cues.get("c1")?.scene_id).toBeNull();
  });

  it("places a create whose neighbour is gone at the end of its scene, like the server", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({
      clientId: "x",
      ops: [
        { op: "create", table: "scenes", id: "s1", fields: { name: "S" } },
        cue("c1", "1"),
        cue("c2", "2"),
        cue("c3", "3"),
        { op: "update", table: "cues", id: "c1", fields: { scene_id: "s1" } },
        { op: "update", table: "cues", id: "c2", fields: { scene_id: "s1" } },
      ],
    });
    await store.load();
    const done = store.mutate([
      {
        op: "create",
        table: "cues",
        id: "n",
        fields: { number: "2.5", scene_id: "s1" },
        after: "deleted",
      },
    ]);
    expect(numbers(store)).toEqual(["1", "2", "2.5", "3"]);
    await releaseNext();
    await done;
    expect(numbers(store)).toEqual(["1", "2", "2.5", "3"]);
  });

  it("keeps untouched rows' identity across changes", async () => {
    const { server, store, releaseNext } = setup();
    server.apply({ clientId: "x", ops: [cue("c1", "1"), cue("c2", "2")] });
    await store.load();
    const c1 = store.tables.cues.get("c1");
    const done = store.mutate([{ op: "update", table: "cues", id: "c2", fields: { number: "3" } }]);
    expect(store.tables.cues.get("c1")).toBe(c1);
    await releaseNext();
    await done;
  });
});

describe("snapshot refetch (structural sharing)", () => {
  it("keeps unchanged rows, tables, order lists and joins identical after a refetch", async () => {
    const server = new FakeServer();
    const transport: ShowTransport = {
      // Over the network every snapshot is a fresh copy.
      snapshot: async () => structuredClone(server.snapshot()),
      mutate: async (req) => server.apply(req),
    };
    const store = new ShowStoreImpl(transport, { clientId: "me", userId: "u1", now: () => 1 });
    server.apply({
      clientId: "x",
      ops: [
        cue("c1", "1"),
        cue("c2", "2"),
        { op: "create", table: "persons", id: "p1", fields: { name: "Casey" } },
        { op: "link", table: "cues", id: "c1", field: "assignees", targetId: "p1" },
      ],
    });
    await store.load();
    const before = store.getState();

    // Someone else changes c2 (we never saw the broadcast); refetch.
    server.apply({
      clientId: "x",
      ops: [{ op: "update", table: "cues", id: "c2", fields: { number: "3" } }],
    });
    await store.refresh();
    const after = store.getState();
    expect(after.tables.cues.get("c1")).toBe(before.tables.cues.get("c1"));
    expect(after.tables.cues.get("c2")).not.toBe(before.tables.cues.get("c2"));
    expect(after.tables.cues.get("c2")?.number).toBe("3");
    expect(after.tables.persons).toBe(before.tables.persons);
    expect(after.order.cues).toBe(before.order.cues);
    expect(after.joins.cueAssignees).toBe(before.joins.cueAssignees);

    // Nothing changed at all: everything is shared.
    await store.refresh();
    const again = store.getState();
    expect(again.tables.cues).toBe(after.tables.cues);
    expect(again.fieldOptions).toBe(after.fieldOptions);
  });

  it("keeps show-level fields from `show` messages and setShow", async () => {
    const { store } = setup();
    const withShow = new ShowStoreImpl(
      { snapshot: async () => new FakeServer().snapshot(), mutate: async () => ({}) as never },
      { show: { name: "A", currentSession: null } },
    );
    expect(withShow.getState().show).toEqual({ name: "A", currentSession: null });
    expect(store.getState().show).toBeNull();
    const listener = vi.fn();
    store.subscribe(listener);
    store.handleServerMessage({ type: "show", name: "B", currentSession: "Tech 2" });
    expect(store.getState().show).toEqual({ name: "B", currentSession: "Tech 2" });
    expect(listener).toHaveBeenCalledTimes(1);
    // The same values again (our own PATCH, then its broadcast): no re-render.
    const before = store.getState();
    store.setShow({ name: "B", currentSession: "Tech 2" });
    expect(store.getState()).toBe(before);
  });
});
