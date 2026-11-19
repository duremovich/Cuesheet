// Teams (routes/teams.ts) and team-derived show access (access.ts): effective roles,
// team CRUD and member rules, shows moving in and out of a team, and open sockets
// following every access change (`refreshAccess`).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  MembersResponse,
  ShowResponse,
  ShowSummaryDTO,
  ShowsResponse,
  TeamDTO,
  TeamMembersResponse,
  TeamRole,
  TeamShowsResponse,
  TeamsResponse,
} from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { ServerMessage } from "../../src/shared/ws";
import {
  canGrant,
  effectiveRole,
  maxRole,
  resolveRole,
  showRoleFromTeamRole,
} from "../../src/worker/access";
import { getDb } from "../../src/worker/db/d1/client";
import type { ShowExport } from "../../src/worker/routes/backup";
import { api, collect, createShow, isType, loginAdmin, newUser, post, WS_HEADERS } from "./helpers";

type User = Awaited<ReturnType<typeof newUser>>;

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  api(path, { method, cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function createTeam(cookie: string, name = "Crew"): Promise<TeamDTO> {
  const res = await post("/api/teams", { name }, cookie);
  expect(res.status).toBe(201);
  return ((await res.json()) as { team: TeamDTO }).team;
}

async function addToTeam(teamId: string, user: User, role: TeamRole, cookie: string) {
  const res = await post(`/api/teams/${teamId}/members`, { email: user.email, role }, cookie);
  expect(res.status, await res.clone().text()).toBe(201);
}

async function addToShow(showId: string, user: User, role: string, cookie: string) {
  const res = await post(`/api/shows/${showId}/members`, { email: user.email, role }, cookie);
  expect(res.status, await res.clone().text()).toBe(201);
}

function moveShow(showId: string, teamId: string | null, cookie: string) {
  return send("PATCH", `/api/shows/${showId}`, cookie, { teamId });
}

async function roleIn(showId: string, cookie: string): Promise<string | null> {
  const res = await api(`/api/shows/${showId}`, { cookie });
  if (res.status === 404) return null;
  expect(res.status).toBe(200);
  return ((await res.json()) as ShowResponse).role;
}

async function listed(cookie: string, showId: string): Promise<ShowSummaryDTO | undefined> {
  const res = (await (await api("/api/shows", { cookie })).json()) as ShowsResponse;
  return res.shows.find((s) => s.id === showId);
}

async function openSocket(showId: string, cookie: string) {
  const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
  expect(res.status).toBe(101);
  const s = collect(res.webSocket as WebSocket);
  await s.next(isType("hello"));
  return s;
}

const roleMsg =
  (role: string) =>
  (m: ServerMessage): m is ServerMessage =>
    m.type === "role" && m.role === role;

describe("access rules (pure)", () => {
  it("maps team roles, takes the highest, caps grants", () => {
    expect(showRoleFromTeamRole("owner")).toBe("editor");
    expect(showRoleFromTeamRole("admin")).toBe("editor");
    expect(showRoleFromTeamRole("commenter")).toBe("commenter");
    expect(maxRole("viewer", "editor")).toBe("editor");
    expect(maxRole("owner", "editor")).toBe("owner");
    expect(maxRole(null, null)).toBeNull();
    expect(resolveRole("viewer", "admin")).toBe("editor");
    expect(resolveRole("owner", "viewer")).toBe("owner");
    expect(resolveRole(null, "viewer")).toBe("viewer");
    expect(resolveRole(null, null)).toBeNull();
    expect(canGrant("admin", "admin")).toBe(true);
    expect(canGrant("editor", "admin")).toBe(false);
    expect(canGrant("editor", "editor")).toBe(true);
    expect(canGrant("commenter", "viewer")).toBe(false);
    expect(canGrant("owner", "owner")).toBe(false);
    expect(canGrant("owner", "editor")).toBe(true);
  });
});

describe("effective show role", () => {
  it("direct only, team only, both (the highest wins); team owner/admin are editors", async () => {
    const admin = await loginAdmin();
    const lead = await newUser(admin, "Lead");
    const direct = await newUser(admin, "Direct only");
    const teamOnly = await newUser(admin, "Team only");
    const both = await newUser(admin, "Both");
    const teamAdmin = await newUser(admin, "Team admin");
    const outsider = await newUser(admin, "Outsider");
    const team = await createTeam(lead.cookie, "Effective");
    const show = await createShow(lead.cookie, "Effective show");
    await addToShow(show.id, direct, "commenter", lead.cookie);
    await addToShow(show.id, both, "viewer", lead.cookie);
    await addToTeam(team.id, teamOnly, "commenter", lead.cookie);
    await addToTeam(team.id, both, "editor", lead.cookie);
    await addToTeam(team.id, teamAdmin, "admin", lead.cookie);
    expect((await moveShow(show.id, team.id, lead.cookie)).status).toBe(200);

    const db = getDb(env);
    expect(await effectiveRole(db, show.id, lead.id)).toBe("owner"); // team owner + show owner
    expect(await effectiveRole(db, show.id, direct.id)).toBe("commenter");
    expect(await effectiveRole(db, show.id, teamOnly.id)).toBe("commenter");
    expect(await effectiveRole(db, show.id, both.id)).toBe("editor");
    expect(await effectiveRole(db, show.id, teamAdmin.id)).toBe("editor");
    expect(await effectiveRole(db, show.id, outsider.id)).toBeNull();
    expect(await effectiveRole(db, "no-such-show", lead.id)).toBeNull();

    // Every place that reads the role agrees.
    expect(await roleIn(show.id, teamOnly.cookie)).toBe("commenter");
    expect(await roleIn(show.id, both.cookie)).toBe("editor");
    expect(await roleIn(show.id, teamAdmin.cookie)).toBe("editor");
    expect(await roleIn(show.id, outsider.cookie)).toBeNull();
    expect(await listed(teamOnly.cookie, show.id)).toMatchObject({
      role: "commenter",
      teamId: team.id,
      teamName: "Effective",
    });
    expect(await listed(both.cookie, show.id)).toMatchObject({ role: "editor" });
    expect(await listed(direct.cookie, show.id)).toMatchObject({ role: "commenter" });
    expect(await listed(outsider.cookie, show.id)).toBeUndefined();
    // A team editor really can edit (the DO gets the effective role); a team commenter can't.
    const cue = { ops: [{ op: "create", table: "cues", id: newId(), fields: { number: "1" } }] };
    expect((await post(`/api/shows/${show.id}/mutate`, cue, both.cookie)).status).toBe(200);
    expect((await post(`/api/shows/${show.id}/mutate`, cue, teamOnly.cookie)).status).toBe(403);
    // Team owner/admins never become the show's owner.
    expect(
      (await api(`/api/shows/${show.id}/export.json`, { cookie: teamAdmin.cookie })).status,
    ).toBe(403);
  });

  it("the members list shows direct and team members once, with their sources", async () => {
    const admin = await loginAdmin();
    const lead = await newUser(admin, "M Lead");
    const guest = await newUser(admin, "M Guest");
    const both = await newUser(admin, "M Both");
    const teamOnly = await newUser(admin, "M Team");
    const team = await createTeam(lead.cookie, "Listed");
    const show = await createShow(lead.cookie, "Listed show");
    await addToShow(show.id, guest, "viewer", lead.cookie);
    await addToShow(show.id, both, "viewer", lead.cookie);
    await addToTeam(team.id, both, "admin", lead.cookie);
    await addToTeam(team.id, teamOnly, "commenter", lead.cookie);
    await moveShow(show.id, team.id, lead.cookie);

    const res = (await (
      await api(`/api/shows/${show.id}/members`, { cookie: guest.cookie })
    ).json()) as MembersResponse;
    const by = Object.fromEntries(res.members.map((m) => [m.name, m]));
    expect(res.members).toHaveLength(4);
    expect(by["M Lead"]).toMatchObject({ role: "owner", source: "direct", teamRole: "owner" });
    expect(by["M Guest"]).toMatchObject({
      role: "viewer",
      source: "direct",
      directRole: "viewer",
      teamRole: null,
      invitedBy: { id: lead.id, name: "M Lead" },
    });
    expect(by["M Both"]).toMatchObject({
      role: "editor",
      source: "direct",
      directRole: "viewer",
      teamRole: "admin",
    });
    expect(by["M Team"]).toMatchObject({
      role: "commenter",
      source: "team",
      directRole: null,
      teamRole: "commenter",
      invitedBy: { id: lead.id, name: "M Lead" },
    });
    expect(by["M Team"]?.joinedAt).toBeGreaterThan(0);

    // Team-derived people are managed in the team, not here.
    const path = `/api/shows/${show.id}/members/${teamOnly.id}`;
    expect((await send("PATCH", path, lead.cookie, { role: "editor" })).status).toBe(409);
    const removed = await send("DELETE", path, lead.cookie);
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "Manage this person in the team" });
    // Leaving a show you only reach through the team: leave the team instead.
    expect((await post(`/api/shows/${show.id}/leave`, {}, teamOnly.cookie)).status).toBe(400);
  });
});

describe("teams", () => {
  it("create, list, read (members only), rename and policy (owner/admin), delete (owner, empty)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "T Owner");
    const teamAdmin = await newUser(admin, "T Admin");
    const editor = await newUser(admin, "T Editor");
    const outsider = await newUser(admin, "T Outsider");
    expect((await post("/api/teams", { name: "  " }, owner.cookie)).status).toBe(400);
    expect((await post("/api/teams", { name: "x" })).status).toBe(401);
    const team = await createTeam(owner.cookie, "Lighting");
    expect(team).toMatchObject({ name: "Lighting", role: "owner", invitePolicy: "editors" });
    await addToTeam(team.id, teamAdmin, "admin", owner.cookie);
    await addToTeam(team.id, editor, "editor", owner.cookie);

    const mine = (await (
      await api("/api/teams", { cookie: editor.cookie })
    ).json()) as TeamsResponse;
    expect(mine.teams).toEqual([expect.objectContaining({ id: team.id, role: "editor" })]);
    expect((await api(`/api/teams/${team.id}`, { cookie: editor.cookie })).status).toBe(200);
    expect((await api(`/api/teams/${team.id}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await api("/api/teams/nope", { cookie: owner.cookie })).status).toBe(404);
    expect((await api(`/api/teams/${team.id}/members`, { cookie: outsider.cookie })).status).toBe(
      404,
    );

    const path = `/api/teams/${team.id}`;
    expect((await send("PATCH", path, editor.cookie, { name: "Mine" })).status).toBe(403);
    expect((await send("PATCH", path, teamAdmin.cookie, { invitePolicy: "nobody" })).status).toBe(
      400,
    );
    expect((await send("PATCH", path, teamAdmin.cookie, {})).status).toBe(400);
    const renamed = await send("PATCH", path, teamAdmin.cookie, {
      name: " Lights ",
      invitePolicy: "owner",
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { team: TeamDTO }).team).toMatchObject({
      name: "Lights",
      invitePolicy: "owner",
      role: "admin",
    });

    // Delete: owner only, and only without shows.
    const show = await createShow(owner.cookie, "In the team");
    expect((await moveShow(show.id, team.id, owner.cookie)).status).toBe(200);
    expect((await send("DELETE", path, teamAdmin.cookie)).status).toBe(403);
    expect((await send("DELETE", path, owner.cookie)).status).toBe(409);
    expect((await moveShow(show.id, null, owner.cookie)).status).toBe(200);
    expect((await send("DELETE", path, owner.cookie)).status).toBe(200);
    expect((await api(path, { cookie: owner.cookie })).status).toBe(404);
    const left = (await (
      await api("/api/teams", { cookie: editor.cookie })
    ).json()) as TeamsResponse;
    expect(left.teams.map((t) => t.id)).not.toContain(team.id);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM team_memberships WHERE team_id = ?",
    )
      .bind(team.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    // The show is still there, personal.
    expect(await listed(owner.cookie, show.id)).toMatchObject({ teamId: null, teamName: null });
  });

  it("adding people: who may, up to which role; existing accounts only", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "A Owner");
    const teamAdmin = await newUser(admin, "A Admin");
    const editor = await newUser(admin, "A Editor");
    const commenter = await newUser(admin, "A Commenter");
    const [x, y, z] = [
      await newUser(admin, "A X"),
      await newUser(admin, "A Y"),
      await newUser(admin, "A Z"),
    ];
    const team = await createTeam(owner.cookie, "Adders");
    const add = (u: User, role: string, cookie: string) =>
      post(`/api/teams/${team.id}/members`, { email: u.email, role }, cookie);
    expect((await add(teamAdmin, "owner", owner.cookie)).status).toBe(400);
    expect((await add(teamAdmin, "boss", owner.cookie)).status).toBe(400);
    await addToTeam(team.id, teamAdmin, "admin", owner.cookie);
    await addToTeam(team.id, editor, "editor", teamAdmin.cookie); // admins add (up to admin)
    await addToTeam(team.id, commenter, "commenter", editor.cookie); // editors add (policy)
    expect((await add(x, "admin", editor.cookie)).status).toBe(403); // above their own role
    expect((await add(x, "viewer", commenter.cookie)).status).toBe(403); // commenters never
    const ghost = await post(
      `/api/teams/${team.id}/members`,
      { email: "ghost@test.local", role: "viewer" },
      owner.cookie,
    );
    expect(ghost.status).toBe(404);
    expect((await add(editor, "viewer", owner.cookie)).status).toBe(409);
    await addToTeam(team.id, x, "admin", teamAdmin.cookie);

    // Policy "owner": owner and admins only.
    await send("PATCH", `/api/teams/${team.id}`, owner.cookie, { invitePolicy: "owner" });
    expect((await add(y, "viewer", editor.cookie)).status).toBe(403);
    await addToTeam(team.id, y, "viewer", teamAdmin.cookie);
    await addToTeam(team.id, z, "viewer", owner.cookie);

    const res = (await (
      await api(`/api/teams/${team.id}/members`, { cookie: commenter.cookie })
    ).json()) as TeamMembersResponse;
    const by = Object.fromEntries(res.members.map((m) => [m.name, m]));
    expect(by["A Owner"]).toMatchObject({ role: "owner", invitedBy: null });
    expect(by["A Commenter"]).toMatchObject({
      role: "commenter",
      email: commenter.email,
      invitedBy: { id: editor.id, name: "A Editor" },
    });
    expect(by["A Commenter"]?.joinedAt).toBeGreaterThan(0);
    expect(by["A Commenter"]).toHaveProperty("lastActiveAt");
  });

  it("managing members: owner/admins everyone but the owner; editors their own invitees", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "G Owner");
    const admin1 = await newUser(admin, "G Admin 1");
    const admin2 = await newUser(admin, "G Admin 2");
    const editor = await newUser(admin, "G Editor");
    const other = await newUser(admin, "G Other editor");
    const mine = await newUser(admin, "G Mine");
    const theirs = await newUser(admin, "G Theirs");
    const team = await createTeam(owner.cookie, "Managers");
    await addToTeam(team.id, admin1, "admin", owner.cookie);
    await addToTeam(team.id, admin2, "admin", owner.cookie);
    await addToTeam(team.id, editor, "editor", owner.cookie);
    await addToTeam(team.id, other, "editor", owner.cookie);
    await addToTeam(team.id, mine, "viewer", editor.cookie);
    await addToTeam(team.id, theirs, "viewer", other.cookie);
    const member = (u: User) => `/api/teams/${team.id}/members/${u.id}`;
    const setRole = (u: User, role: string, by: User) =>
      send("PATCH", member(u), by.cookie, { role });

    // Editors: their own invitees, within their role.
    expect((await setRole(mine, "commenter", editor)).status).toBe(200);
    expect((await setRole(mine, "admin", editor)).status).toBe(403);
    expect((await setRole(theirs, "commenter", editor)).status).toBe(403);
    expect((await send("DELETE", member(theirs), editor.cookie)).status).toBe(403);
    // Once someone above them made their invitee an admin, it's out of their hands.
    expect((await setRole(mine, "admin", admin1)).status).toBe(200);
    expect((await setRole(mine, "viewer", editor)).status).toBe(403);
    expect((await setRole(mine, "commenter", admin1)).status).toBe(200);
    expect((await send("DELETE", member(mine), editor.cookie)).status).toBe(200);
    // Under the owner-only policy editors manage nobody (they can't add people either).
    await send("PATCH", `/api/teams/${team.id}`, owner.cookie, { invitePolicy: "owner" });
    expect((await setRole(theirs, "commenter", other)).status).toBe(403);
    await send("PATCH", `/api/teams/${team.id}`, owner.cookie, { invitePolicy: "editors" });
    expect((await setRole(theirs, "commenter", other)).status).toBe(200);

    // Admins manage other admins and everyone else, never the owner.
    expect((await setRole(admin2, "editor", admin1)).status).toBe(200);
    expect((await setRole(admin2, "admin", admin1)).status).toBe(200);
    expect((await setRole(owner, "admin", admin1)).status).toBe(400);
    expect((await send("DELETE", member(owner), admin1.cookie)).status).toBe(400);
    expect((await setRole(admin2, "owner", owner)).status).toBe(400); // that's a transfer
    expect((await setRole(admin1, "editor", admin1)).status).toBe(400); // not yourself
    expect((await send("DELETE", member(admin1), admin1.cookie)).status).toBe(400);
    expect((await send("DELETE", member(admin2), admin1.cookie)).status).toBe(200);
    expect((await send("DELETE", member(admin2), admin1.cookie)).status).toBe(404);
  });

  it("leave (not the owner) and transfer (owner → admin, one owner)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "L Owner");
    const next = await newUser(admin, "L Next");
    const leaver = await newUser(admin, "L Leaver");
    const outsider = await newUser(admin, "L Outsider");
    const team = await createTeam(owner.cookie, "Handover");
    await addToTeam(team.id, next, "viewer", owner.cookie);
    await addToTeam(team.id, leaver, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "Team show");
    await moveShow(show.id, team.id, owner.cookie);

    expect((await post(`/api/teams/${team.id}/leave`, {}, owner.cookie)).status).toBe(400);
    const socket = await openSocket(show.id, leaver.cookie);
    expect((await post(`/api/teams/${team.id}/leave`, {}, leaver.cookie)).status).toBe(200);
    expect(await socket.closedWith()).toBe(4003);
    expect(await roleIn(show.id, leaver.cookie)).toBeNull();
    expect((await api(`/api/teams/${team.id}`, { cookie: leaver.cookie })).status).toBe(404);

    const transfer = (body: unknown, cookie: string) =>
      post(`/api/teams/${team.id}/transfer`, body, cookie);
    expect((await transfer({ userId: owner.id }, next.cookie)).status).toBe(403);
    expect((await transfer({ userId: outsider.id }, owner.cookie)).status).toBe(404);
    expect((await transfer({ email: "nobody@test.local" }, owner.cookie)).status).toBe(404);
    expect((await transfer({}, owner.cookie)).status).toBe(400);
    expect((await transfer({ userId: owner.id }, owner.cookie)).status).toBe(400);
    const nextSocket = await openSocket(show.id, next.cookie);
    expect((await transfer({ email: next.email.toUpperCase() }, owner.cookie)).status).toBe(200);
    // viewer → team owner: an editor on the team's shows, live.
    expect(await nextSocket.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    nextSocket.ws.close();
    const members = (await (
      await api(`/api/teams/${team.id}/members`, { cookie: owner.cookie })
    ).json()) as TeamMembersResponse;
    const roles = Object.fromEntries(members.members.map((m) => [m.name, m.role]));
    expect(roles).toEqual({ "L Owner": "admin", "L Next": "owner" });
    // The show's owner is still its creator: a team transfer doesn't move shows.
    expect(await roleIn(show.id, owner.cookie)).toBe("owner");
    expect(await roleIn(show.id, next.cookie)).toBe("editor");
    expect((await post(`/api/teams/${team.id}/leave`, {}, owner.cookie)).status).toBe(200);
  });
});

describe("shows in teams", () => {
  it("creates a show in a team (team editors and up)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "C Owner");
    const editor = await newUser(admin, "C Editor");
    const commenter = await newUser(admin, "C Commenter");
    const outsider = await newUser(admin, "C Outsider");
    const team = await createTeam(owner.cookie, "Creators");
    await addToTeam(team.id, editor, "editor", owner.cookie);
    await addToTeam(team.id, commenter, "commenter", owner.cookie);
    const make = (cookie: string) =>
      post("/api/shows", { name: "Team made", teamId: team.id }, cookie);
    expect((await make(commenter.cookie)).status).toBe(403);
    expect((await make(outsider.cookie)).status).toBe(404);
    expect((await post("/api/shows", { name: "x", teamId: 5 }, owner.cookie)).status).toBe(400);
    const res = await make(editor.cookie);
    expect(res.status).toBe(201);
    const { show } = (await res.json()) as { show: ShowSummaryDTO };
    expect(show).toMatchObject({ role: "owner", teamId: team.id, teamName: "Creators" });
    // The whole team has it at once, including whoever joins later.
    expect(await listed(owner.cookie, show.id)).toMatchObject({ role: "editor" });
    expect(await listed(commenter.cookie, show.id)).toMatchObject({ role: "commenter" });
    const late = await newUser(admin, "C Late");
    await addToTeam(team.id, late, "viewer", owner.cookie);
    expect(await roleIn(show.id, late.cookie)).toBe("viewer");
    const teamShows = (await (
      await api(`/api/teams/${team.id}/shows`, { cookie: late.cookie })
    ).json()) as TeamShowsResponse;
    expect(teamShows.shows.map((s) => [s.id, s.role])).toEqual([[show.id, "viewer"]]);
    expect((await api(`/api/teams/${team.id}/shows`, { cookie: outsider.cookie })).status).toBe(
      404,
    );
    // A plain show stays personal.
    expect((await createShow(editor.cookie, "Personal")).teamId).toBeNull();
  });

  it("moving a show in and out: who may, and access appears/disappears live", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "V Owner");
    const showEditor = await newUser(admin, "V Show editor");
    const teamAdmin = await newUser(admin, "V Team admin");
    const teamViewer = await newUser(admin, "V Team viewer");
    const guest = await newUser(admin, "V Guest");
    const team = await createTeam(owner.cookie, "Movers");
    const other = await createTeam(teamAdmin.cookie, "Elsewhere");
    await addToTeam(team.id, teamAdmin, "admin", owner.cookie);
    await addToTeam(team.id, teamViewer, "viewer", owner.cookie);
    await addToTeam(team.id, guest, "admin", owner.cookie);
    const show = await createShow(owner.cookie, "Moving");
    await addToShow(show.id, showEditor, "editor", owner.cookie);
    await addToShow(show.id, guest, "viewer", owner.cookie);

    // Not the show's owner: no.
    expect((await moveShow(show.id, team.id, showEditor.cookie)).status).toBe(403);
    // A team the owner isn't in: 404; one where they're below editor: 403.
    expect((await moveShow(show.id, other.id, owner.cookie)).status).toBe(404);
    await addToTeam(other.id, owner, "commenter", teamAdmin.cookie);
    expect((await moveShow(show.id, other.id, owner.cookie)).status).toBe(403);
    expect((await moveShow(show.id, 42 as unknown as string, owner.cookie)).status).toBe(400);
    expect(await roleIn(show.id, teamViewer.cookie)).toBeNull();

    // In: the team gets access; a direct viewer who is a team admin is raised, live.
    const guestSocket = await openSocket(show.id, guest.cookie);
    expect((await moveShow(show.id, team.id, owner.cookie)).status).toBe(200);
    expect(await guestSocket.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    expect(await roleIn(show.id, teamViewer.cookie)).toBe("viewer");
    expect(await listed(teamViewer.cookie, show.id)).toMatchObject({ teamName: "Movers" });

    // Out (a team admin may take a show out of their team, not move it in): access goes.
    const viewerSocket = await openSocket(show.id, teamViewer.cookie);
    expect((await moveShow(show.id, null, showEditor.cookie)).status).toBe(403);
    expect((await moveShow(show.id, null, teamAdmin.cookie)).status).toBe(200);
    expect(await viewerSocket.closedWith()).toBe(4003);
    expect(await guestSocket.next(roleMsg("viewer"))).toEqual({ type: "role", role: "viewer" });
    guestSocket.ws.close();
    expect(await roleIn(show.id, teamViewer.cookie)).toBeNull();
    expect(await roleIn(show.id, teamAdmin.cookie)).toBeNull();
    expect(await listed(owner.cookie, show.id)).toMatchObject({ teamId: null, role: "owner" });
    expect((await moveShow(show.id, team.id, teamAdmin.cookie)).status).toBe(404);
  });

  it("team role changes and removal follow into open shows; direct members keep theirs", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "R Owner");
    const member = await newUser(admin, "R Member");
    const both = await newUser(admin, "R Both");
    const team = await createTeam(owner.cookie, "Live");
    await addToTeam(team.id, member, "viewer", owner.cookie);
    await addToTeam(team.id, both, "editor", owner.cookie);
    const a = await createShow(owner.cookie, "Live A");
    const b = await createShow(owner.cookie, "Live B");
    for (const s of [a, b]) await moveShow(s.id, team.id, owner.cookie);
    await addToShow(a.id, both, "commenter", owner.cookie);

    const inA = await openSocket(a.id, member.cookie);
    const inB = await openSocket(b.id, member.cookie);
    const path = (u: User) => `/api/teams/${team.id}/members/${u.id}`;
    expect((await send("PATCH", path(member), owner.cookie, { role: "editor" })).status).toBe(200);
    expect(await inA.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    expect(await inB.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    expect((await send("DELETE", path(member), owner.cookie)).status).toBe(200);
    expect(await inA.closedWith()).toBe(4003);
    expect(await inB.closedWith()).toBe(4003);
    expect(await roleIn(a.id, member.cookie)).toBeNull();

    // A direct member of A: removing them from the team leaves A open (commenter), B closed.
    const bothA = await openSocket(a.id, both.cookie);
    const bothB = await openSocket(b.id, both.cookie);
    expect((await send("DELETE", path(both), owner.cookie)).status).toBe(200);
    expect(await bothA.next(roleMsg("commenter"))).toEqual({ type: "role", role: "commenter" });
    expect(await bothB.closedWith()).toBe(4003);
    expect(bothA.ws.readyState).toBe(WebSocket.OPEN);
    // And the other way: back in the team, then removed from the show directly: they keep
    // the team role (notified, not disconnected).
    await addToTeam(team.id, both, "editor", owner.cookie);
    expect(await bothA.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    expect(
      (await send("DELETE", `/api/shows/${a.id}/members/${both.id}`, owner.cookie)).status,
    ).toBe(200);
    expect(await bothA.next(roleMsg("editor"))).toEqual({ type: "role", role: "editor" });
    expect(bothA.ws.readyState).toBe(WebSocket.OPEN);
    expect(await roleIn(a.id, both.cookie)).toBe("editor");
    bothA.ws.close();
  });

  it("sign out everywhere closes team shows too", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "O Owner");
    const member = await newUser(admin, "O Member");
    const team = await createTeam(owner.cookie, "Signout");
    await addToTeam(team.id, member, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "Signout show");
    await moveShow(show.id, team.id, owner.cookie);
    const socket = await openSocket(show.id, member.cookie);
    expect((await post("/api/auth/logout-all", {}, member.cookie)).status).toBe(200);
    expect(await socket.closedWith()).toBe(4003);
  });

  it("the owner's export names the team and lists the direct members", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "E Owner");
    const member = await newUser(admin, "E Member");
    const team = await createTeam(owner.cookie, "Exporters");
    await addToTeam(team.id, member, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "Exported team show");
    await moveShow(show.id, team.id, owner.cookie);
    const out = (await (
      await api(`/api/shows/${show.id}/export.json`, { cookie: owner.cookie })
    ).json()) as ShowExport;
    expect(out.show).toMatchObject({ teamId: team.id, teamName: "Exporters" });
    expect(out.members.map((m) => m.userId)).toEqual([owner.id]);
  });
});
