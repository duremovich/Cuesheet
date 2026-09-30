// /api/shows/:id/{mutate,snapshot,history,members}: the HTTP side of the show data layer.
import { describe, expect, it } from "vitest";
import type { MembersResponse } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { HistoryResponse, MutateResponse, Op, SnapshotResponse } from "../../src/shared/ops";
import { api, collect, createShow, isType, loginAdmin, newUser, post, WS_HEADERS } from "./helpers";

function mutate(showId: string, cookie: string, ops: Op[] | unknown, clientId = "test-client") {
  return post(`/api/shows/${showId}/mutate`, { clientId, ops }, cookie);
}

async function openSocket(showId: string, cookie: string) {
  const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
  expect(res.status).toBe(101);
  return collect(res.webSocket as WebSocket);
}

describe("show data API", () => {
  it("mutate → snapshot → history, with user names resolved", async () => {
    const cookie = await loginAdmin();
    const show = await createShow(cookie);
    const sceneId = newId();
    const cueId = newId();
    const res = await mutate(show.id, cookie, [
      { op: "create", table: "scenes", id: sceneId, fields: { number: "101", name: "Speakeasy" } },
      { op: "create", table: "cues", id: cueId, fields: { number: "1", scene_id: sceneId } },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MutateResponse;
    expect(body).toMatchObject({ prevVersion: 0, version: 2 });
    expect(body.ops.map((o) => o.op)).toEqual(["create", "create"]);

    const snap = (await (
      await api(`/api/shows/${show.id}/snapshot`, { cookie })
    ).json()) as SnapshotResponse;
    expect(snap.version).toBe(2);
    expect(snap.tables.cues).toMatchObject([{ id: cueId, number: "1", scene_id: sceneId }]);
    expect(snap.fieldOptions["cues.status"]?.map((o) => o.value)).toEqual([
      "Not started",
      "In process",
      "Rendered",
      "Cued",
    ]);
    expect(snap.fieldOptions["notes.priority"]).toHaveLength(5);

    const hist = (await (
      await api(`/api/shows/${show.id}/history?table=cues&id=${cueId}`, { cookie })
    ).json()) as HistoryResponse;
    expect(hist.changes).toMatchObject([
      { field: "*", userName: "Admin", recordId: cueId, table: "cues", clientId: "test-client" },
    ]);

    // Errors: 400 with the failing op's index; malformed body.
    const bad = await mutate(show.id, cookie, [
      { op: "update", table: "cues", id: cueId, fields: { number: "2" } },
      { op: "update", table: "cues", id: cueId, fields: { status: "Nope" } },
    ]);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: expect.stringMatching(/not an option/),
      opIndex: 1,
    });
    expect((await mutate(show.id, cookie, "nope")).status).toBe(400);
    expect((await mutate(show.id, cookie, new Array(1001).fill({}))).status).toBe(400);

    // Prototype-polluting custom keys are refused by the Worker, before the DO.
    const polluted = await api(`/api/shows/${show.id}/mutate`, {
      method: "POST",
      cookie,
      body: `{"clientId":"x","ops":[{"op":"update","table":"cues","id":"${cueId}","fields":{"custom":{"__proto__":{"admin":true}}}}]}`,
    });
    expect(polluted.status).toBe(400);
    expect(await polluted.json()).toMatchObject({ error: /not allowed/, opIndex: 0 });

    // Bodies over 4 MB: 413, whether or not Content-Length says so up front.
    const big = { clientId: "x", ops: [], pad: "x".repeat(4 * 1024 * 1024) };
    expect((await mutate(show.id, cookie, [], "x")).status).toBe(200);
    expect((await post(`/api/shows/${show.id}/mutate`, big, cookie)).status).toBe(413);
    const stream = new Blob([JSON.stringify(big)]).stream();
    const chunked = await api(`/api/shows/${show.id}/mutate`, {
      method: "POST",
      cookie,
      body: stream,
      headers: { "Content-Type": "application/json" },
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it("non-members get 404 on every data route", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const outsider = await newUser(admin);
    for (const path of ["snapshot", "history", "members"]) {
      expect((await api(`/api/shows/${show.id}/${path}`, { cookie: outsider.cookie })).status).toBe(
        404,
      );
    }
    expect((await mutate(show.id, outsider.cookie, [])).status).toBe(404);
  });

  it("broadcasts each batch to other members' sockets", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const bob = await newUser(admin, "Bob");
    await post(`/api/shows/${show.id}/members`, { email: bob.email, role: "editor" }, admin);
    const sock = await openSocket(show.id, bob.cookie);
    expect(await sock.next(isType("version"))).toEqual({ type: "version", version: 0 });
    const id = newId();
    await mutate(
      show.id,
      admin,
      [{ op: "create", table: "cues", id, fields: { number: "5" } }],
      "alice-tab",
    );
    const msg = await sock.next(isType("ops"));
    expect(msg).toMatchObject({ prevVersion: 0, version: 1, clientId: "alice-tab" });
    expect(msg.ops[0]).toMatchObject({ op: "create", id, fields: { number: "5" } });
    sock.ws.close(1000);
  });

  it("members: owner adds, re-roles and removes; roles are enforced on mutate", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const viewer = await newUser(admin, "Vera Viewer");
    const commenter = await newUser(admin, "Cam Commenter");

    // Only existing accounts; only grantable roles; no duplicates.
    expect(
      (
        await post(
          `/api/shows/${show.id}/members`,
          { email: "ghost@test.local", role: "viewer" },
          admin,
        )
      ).status,
    ).toBe(404);
    expect(
      (await post(`/api/shows/${show.id}/members`, { email: viewer.email, role: "owner" }, admin))
        .status,
    ).toBe(400);
    const added = await post(
      `/api/shows/${show.id}/members`,
      { email: viewer.email, role: "viewer" },
      admin,
    );
    expect(added.status).toBe(201);
    expect(
      (await post(`/api/shows/${show.id}/members`, { email: viewer.email, role: "viewer" }, admin))
        .status,
    ).toBe(409);
    await post(
      `/api/shows/${show.id}/members`,
      { email: commenter.email, role: "commenter" },
      admin,
    );

    const list = (await (
      await api(`/api/shows/${show.id}/members`, { cookie: viewer.cookie })
    ).json()) as MembersResponse;
    expect(list.members.map((m) => [m.name, m.role])).toEqual([
      ["Admin", "owner"],
      ["Cam Commenter", "commenter"],
      ["Vera Viewer", "viewer"],
    ]);
    // Non-owners can't manage members.
    expect(
      (
        await post(
          `/api/shows/${show.id}/members`,
          { email: commenter.email, role: "editor" },
          viewer.cookie,
        )
      ).status,
    ).toBe(403);

    // Viewer: 403 on any op. Commenter: notes only.
    const cue: Op = { op: "create", table: "cues", id: newId(), fields: {} };
    expect((await mutate(show.id, viewer.cookie, [cue])).status).toBe(403);
    expect((await mutate(show.id, commenter.cookie, [cue])).status).toBe(403);
    const note: Op = { op: "create", table: "notes", id: newId(), fields: { body: "hi" } };
    expect((await mutate(show.id, commenter.cookie, [note])).status).toBe(200);

    // Promote the viewer; now they can edit.
    const patch = await api(`/api/shows/${show.id}/members/${viewer.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "editor" }),
      cookie: admin,
    });
    expect(patch.status).toBe(200);
    expect((await mutate(show.id, viewer.cookie, [cue])).status).toBe(200);

    // Removal closes their sockets and revokes access.
    const sock = await openSocket(show.id, viewer.cookie);
    await sock.next(isType("hello"));
    const del = await api(`/api/shows/${show.id}/members/${viewer.id}`, {
      method: "DELETE",
      cookie: admin,
    });
    expect(del.status).toBe(200);
    expect(await sock.closedWith()).toBe(4003);
    expect((await api(`/api/shows/${show.id}`, { cookie: viewer.cookie })).status).toBe(404);

    // The owner can't be demoted or removed.
    const me = list.members.find((m) => m.role === "owner")?.userId;
    expect(
      (await api(`/api/shows/${show.id}/members/${me}`, { method: "DELETE", cookie: admin }))
        .status,
    ).toBe(400);
  });

  it("logout closes the user's show sockets", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin);
    const u = await newUser(admin);
    await post(`/api/shows/${show.id}/members`, { email: u.email, role: "viewer" }, admin);
    const sock = await openSocket(show.id, u.cookie);
    await sock.next(isType("hello"));
    expect((await post("/api/auth/logout", {}, u.cookie)).status).toBe(200);
    expect(await sock.closedWith()).toBe(4003);
  });
});
