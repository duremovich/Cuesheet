// PATCH /api/shows/:id (name, current session) and the `{type:"show"}` broadcast.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ShowResponse, UpdateShowResponse } from "../../src/shared/api";
import {
  api,
  collect,
  connectDO,
  createShow,
  isType,
  loginAdmin,
  newUser,
  post,
  WS_HEADERS,
} from "./helpers";

function patch(showId: string, cookie: string, body: unknown) {
  return api(`/api/shows/${showId}`, { method: "PATCH", body: JSON.stringify(body), cookie });
}

async function openSocket(showId: string, cookie: string) {
  const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
  expect(res.status).toBe(101);
  return collect(res.webSocket as WebSocket);
}

describe("PATCH /api/shows/:id", () => {
  it("sets the session (editors+), renames (owner only), and broadcasts", async () => {
    const admin = await loginAdmin();
    const show = await createShow(admin, "Session show");
    const editor = await newUser(admin, "Ed Editor");
    const commenter = await newUser(admin, "Cam Commenter");
    const viewer = await newUser(admin, "Vera Viewer");
    const outsider = await newUser(admin, "Olly Outsider");
    for (const [u, role] of [
      [editor, "editor"],
      [commenter, "commenter"],
      [viewer, "viewer"],
    ] as const) {
      const res = await post(`/api/shows/${show.id}/members`, { email: u.email, role }, admin);
      expect(res.status).toBe(201);
    }

    // New shows have no session.
    const before = (await (
      await api(`/api/shows/${show.id}`, { cookie: viewer.cookie })
    ).json()) as ShowResponse;
    expect(before.show.currentSession).toBeNull();

    const sock = await openSocket(show.id, viewer.cookie);
    await sock.next(isType("hello"));

    // An editor sets the session; everyone connected hears about it.
    const res = await patch(show.id, editor.cookie, { current_session: "  Tech 2 " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UpdateShowResponse).show).toEqual({
      id: show.id,
      name: "Session show",
      currentSession: "Tech 2",
    });
    expect(await sock.next(isType("show"))).toEqual({
      type: "show",
      name: "Session show",
      currentSession: "Tech 2",
    });
    const after = (await (
      await api(`/api/shows/${show.id}`, { cookie: commenter.cookie })
    ).json()) as ShowResponse;
    expect(after.show.currentSession).toBe("Tech 2");

    // Commenters and viewers can't; non-members get 404; editors can't rename.
    expect((await patch(show.id, commenter.cookie, { current_session: "x" })).status).toBe(403);
    expect((await patch(show.id, viewer.cookie, { current_session: "x" })).status).toBe(403);
    expect((await patch(show.id, outsider.cookie, { current_session: "x" })).status).toBe(404);
    expect((await patch(show.id, editor.cookie, { name: "Mine now" })).status).toBe(403);

    // Validation.
    expect((await patch(show.id, admin, {})).status).toBe(400);
    expect((await patch(show.id, admin, { current_session: 3 })).status).toBe(400);
    expect((await patch(show.id, admin, { current_session: "x".repeat(101) })).status).toBe(400);
    expect((await patch(show.id, admin, { name: "  " })).status).toBe(400);

    // The owner renames and clears the session in one go.
    const both = await patch(show.id, admin, { name: "Renamed", current_session: "" });
    expect(both.status).toBe(200);
    expect(await sock.next(isType("show"))).toEqual({
      type: "show",
      name: "Renamed",
      currentSession: null,
    });
    const listed = (await (await api("/api/shows", { cookie: admin })).json()) as {
      shows: { id: string; name: string }[];
    };
    expect(listed.shows.find((s) => s.id === show.id)?.name).toBe("Renamed");
  });

  it("ShowDO.notifyShow broadcasts to every socket without storing anything", async () => {
    const stub = env.SHOW.get(env.SHOW.idFromName("notify-show-test"));
    await stub.sync("notify-show-test", "Cached name");
    const a = await connectDO(stub, "user-a");
    const b = await connectDO(stub, "user-b");
    await a.next(isType("hello"));
    await b.next(isType("hello"));
    expect(await stub.notifyShow({ name: "New name", currentSession: "Preview 1" })).toBe(2);
    for (const s of [a, b]) {
      expect(await s.next(isType("show"))).toEqual({
        type: "show",
        name: "New name",
        currentSession: "Preview 1",
      });
    }
    // D1 is the source of truth: the DO's cached meta is untouched.
    expect((await stub.getMeta())?.name).toBe("Cached name");
  });
});
