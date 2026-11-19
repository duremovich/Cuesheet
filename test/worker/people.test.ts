// Delegated inviting (decision 4 of the teams plan): the show invite policy, capped
// grants, managing the people you added, one-step "add people", team invites, pending
// invites (revoke, reissue), the per-inviter limit, people / my access, last activity,
// and invite / "you were added" emails (Resend, stubbed: tests never reach it).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  AddShowPeopleResponse,
  AddTeamPeopleResponse,
  CreateInviteResponse,
  InvitedDTO,
  InviteInfoResponse,
  MembersResponse,
  MyAccessResponse,
  PendingInvitesResponse,
  PeopleResponse,
  ReissueInviteResponse,
  ShowResponse,
  TeamDTO,
  TeamMembersResponse,
  TeamRole,
} from "../../src/shared/api";
import { inviteLimits, recordFailure } from "../../src/worker/auth/rate-limit";
import {
  api,
  collect,
  createShow,
  isType,
  loginAdmin,
  newUser,
  post,
  sessionCookie,
  stubResend,
  WS_HEADERS,
} from "./helpers";

type User = Awaited<ReturnType<typeof newUser>>;
const PASSWORD = "long-enough-pw";
let seq = 0;
const freshEmail = (tag = "new") => `${tag}${Date.now().toString(36)}${seq++}@test.local`;

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  api(path, { method, cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function createTeam(cookie: string, name = "Crew"): Promise<TeamDTO> {
  return (await ok<{ team: TeamDTO }>(post("/api/teams", { name }, cookie), 201)).team;
}

async function addToTeam(teamId: string, user: User, role: TeamRole, cookie: string) {
  await ok(post(`/api/teams/${teamId}/members`, { email: user.email, role }, cookie), 201);
}

async function addToShow(showId: string, user: User, role: string, cookie: string) {
  await ok(post(`/api/shows/${showId}/members`, { email: user.email, role }, cookie), 201);
}

const tokenOf = (path: string) => path.split("/").at(-1) as string;

async function accept(path: string, name = "Joiner") {
  const res = await post(`/api/invites/${tokenOf(path)}/accept`, { name, password: PASSWORD });
  expect(res.status, await res.clone().text()).toBe(201);
  const { user } = (await res.clone().json()) as { user: { id: string } };
  return { cookie: sessionCookie(res), id: user.id };
}

const linkWorks = async (path: string) => (await api(`/api/invites/${tokenOf(path)}`)).status;

async function members(showId: string, cookie: string) {
  return (await ok<MembersResponse>(api(`/api/shows/${showId}/members`, { cookie }))).members;
}

async function pending(path: string, cookie: string) {
  return (await ok<PendingInvitesResponse>(api(path, { cookie }))).invites;
}

/** A show with an owner, a direct editor, a commenter and a viewer. */
async function crew(admin: string, tag: string) {
  const owner = await newUser(admin, `${tag} Owner`);
  const editor = await newUser(admin, `${tag} Editor`);
  const commenter = await newUser(admin, `${tag} Commenter`);
  const viewer = await newUser(admin, `${tag} Viewer`);
  const show = await createShow(owner.cookie, `${tag} show`);
  await addToShow(show.id, editor, "editor", owner.cookie);
  await addToShow(show.id, commenter, "commenter", owner.cookie);
  await addToShow(show.id, viewer, "viewer", owner.cookie);
  return { owner, editor, commenter, viewer, show };
}

describe("show: who may add people (decision 4)", () => {
  it("owner always; editors unless the policy is owner; nobody above their role", async () => {
    const admin = await loginAdmin();
    const { owner, editor, commenter, viewer, show } = await crew(admin, "Add");
    const [a, b, c, d] = [
      await newUser(admin, "Add A"),
      await newUser(admin, "Add B"),
      await newUser(admin, "Add C"),
      await newUser(admin, "Add D"),
    ];
    const add = (u: User, role: string, by: User) =>
      post(`/api/shows/${show.id}/members`, { email: u.email, role }, by.cookie);

    expect((await add(a, "editor", editor)).status).toBe(201); // editors add editors
    expect((await add(b, "viewer", editor)).status).toBe(201);
    expect((await add(c, "owner", editor)).status).toBe(400); // owner is a transfer
    expect((await add(c, "owner", owner)).status).toBe(400);
    expect((await add(c, "viewer", commenter)).status).toBe(403); // commenters never
    expect((await add(c, "viewer", viewer)).status).toBe(403); // viewers never
    const listed = await members(show.id, owner.cookie);
    expect(listed.find((m) => m.userId === a.id)?.invitedBy).toEqual({
      id: editor.id,
      name: "Add Editor",
    });

    // The policy: owner only.
    const policy = (value: unknown, by: User) =>
      send("PATCH", `/api/shows/${show.id}`, by.cookie, { invitePolicy: value });
    expect((await policy("owner", editor)).status).toBe(403);
    expect((await policy("everyone", owner)).status).toBe(400);
    expect((await policy("owner", owner)).status).toBe(200);
    const info = await ok<ShowResponse>(api(`/api/shows/${show.id}`, { cookie: editor.cookie }));
    expect(info.show.invitePolicy).toBe("owner");
    expect((await add(c, "viewer", editor)).status).toBe(403);
    expect((await add(c, "viewer", owner)).status).toBe(201);
    await policy("editors", owner);
    expect((await add(d, "commenter", editor)).status).toBe(201);
  });

  it("an editor through the show's team may add people too (effective role)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "Eff Owner");
    const teamEditor = await newUser(admin, "Eff Team editor");
    const teamViewer = await newUser(admin, "Eff Team viewer");
    const guest = await newUser(admin, "Eff Guest");
    const team = await createTeam(owner.cookie, "Eff team");
    await addToTeam(team.id, teamEditor, "editor", owner.cookie);
    await addToTeam(team.id, teamViewer, "viewer", owner.cookie);
    const show = await createShow(owner.cookie, "Eff show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: team.id }));
    const add = (by: User) =>
      post(`/api/shows/${show.id}/members`, { email: guest.email, role: "viewer" }, by.cookie);
    expect((await add(teamViewer)).status).toBe(403);
    expect((await add(teamEditor)).status).toBe(201);
  });
});

describe("show: managing the people you added (decision 4)", () => {
  it("editors change (within their role) and remove only their own invitees; the owner everyone", async () => {
    const admin = await loginAdmin();
    const { owner, editor, show } = await crew(admin, "Mgr");
    const other = await newUser(admin, "Mgr Other editor");
    await addToShow(show.id, other, "editor", owner.cookie);
    const mine = await newUser(admin, "Mgr Mine");
    const theirs = await newUser(admin, "Mgr Theirs");
    const owners = await newUser(admin, "Mgr Owners");
    await addToShow(show.id, mine, "viewer", editor.cookie);
    await addToShow(show.id, theirs, "viewer", other.cookie);
    await addToShow(show.id, owners, "viewer", owner.cookie);
    const path = (u: User) => `/api/shows/${show.id}/members/${u.id}`;
    const setRole = (u: User, role: string, by: User) =>
      send("PATCH", path(u), by.cookie, { role });

    expect((await setRole(mine, "commenter", editor)).status).toBe(200);
    expect((await setRole(mine, "editor", editor)).status).toBe(200);
    expect((await setRole(mine, "owner", editor)).status).toBe(400);
    expect((await setRole(theirs, "commenter", editor)).status).toBe(403);
    expect((await setRole(owners, "commenter", editor)).status).toBe(403);
    expect((await send("DELETE", path(theirs), editor.cookie)).status).toBe(403);
    expect((await setRole(owner, "viewer", editor)).status).toBe(400); // never the owner
    expect((await send("DELETE", path(owner), editor.cookie)).status).toBe(400);
    expect((await setRole(editor, "viewer", editor)).status).toBe(400); // not yourself
    expect((await send("DELETE", path(editor), editor.cookie)).status).toBe(400);
    // The owner manages every direct member, whoever added them.
    expect((await setRole(theirs, "commenter", owner)).status).toBe(200);
    expect((await send("DELETE", path(theirs), owner.cookie)).status).toBe(200);
    // Under the owner-only policy editors can't manage even their own.
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { invitePolicy: "owner" }));
    expect((await setRole(mine, "viewer", editor)).status).toBe(403);
    expect((await send("DELETE", path(mine), editor.cookie)).status).toBe(403);
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { invitePolicy: "editors" }));
    // Demoted to commenter, they can't manage the people they added any more.
    await ok(send("PATCH", path(editor), owner.cookie, { role: "commenter" }));
    expect((await send("DELETE", path(mine), editor.cookie)).status).toBe(403);
    await ok(send("PATCH", path(editor), owner.cookie, { role: "editor" }));
    const socket = await openSocket(show.id, mine.cookie);
    expect((await send("DELETE", path(mine), editor.cookie)).status).toBe(200);
    expect(await socket.closedWith()).toBe(4003);
    expect((await send("DELETE", path(mine), editor.cookie)).status).toBe(404);
  });
});

async function openSocket(showId: string, cookie: string) {
  const res = await api(`/api/shows/${showId}/ws`, { cookie, headers: WS_HEADERS });
  expect(res.status).toBe(101);
  const s = collect(res.webSocket as WebSocket);
  await s.next(isType("hello"));
  return s;
}

describe("add people in one step", () => {
  it("show: an account is added now; an unknown email gets an invite that joins on accept", async () => {
    const admin = await loginAdmin();
    const { owner, editor, viewer, show } = await crew(admin, "One");
    const known = await newUser(admin, "One Known");
    const people = (body: unknown, by: User) =>
      post(`/api/shows/${show.id}/people`, body, by.cookie);

    const added = await ok<AddShowPeopleResponse>(
      people({ email: ` ${known.email.toUpperCase()} `, role: "commenter" }, editor),
      201,
    );
    expect(added).toEqual({
      added: expect.objectContaining({
        userId: known.id,
        role: "commenter",
        source: "direct",
        invitedBy: { id: editor.id, name: "One Editor" },
      }),
      emailed: false,
    });
    expect((await people({ email: known.email, role: "viewer" }, editor)).status).toBe(409);
    expect((await people({ email: "not an email", role: "viewer" }, editor)).status).toBe(400);
    expect((await people({ email: freshEmail(), role: "owner" }, editor)).status).toBe(400);
    expect((await people({ email: freshEmail(), role: "viewer" }, viewer)).status).toBe(403);

    const email = freshEmail("guest");
    const res = await ok<AddShowPeopleResponse>(people({ email, role: "viewer" }, editor), 201);
    if (!("invited" in res)) throw new Error("expected an invite");
    expect(res.emailed).toBe(false); // no RESEND_API_KEY here
    expect(res.invited).toMatchObject({ email, role: "viewer" });
    expect(res.invited.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{40,}$/);
    expect(res.invited.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const joined = await accept(res.invited.path, "One Guest");
    const row = (await members(show.id, owner.cookie)).find((m) => m.userId === joined.id);
    expect(row).toMatchObject({ role: "viewer", invitedBy: { id: editor.id } });
  });

  it("team: same, with team roles and the team's rules", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "TP Owner");
    const editor = await newUser(admin, "TP Editor");
    const viewer = await newUser(admin, "TP Viewer");
    const known = await newUser(admin, "TP Known");
    const team = await createTeam(owner.cookie, "TP team");
    await addToTeam(team.id, editor, "editor", owner.cookie);
    await addToTeam(team.id, viewer, "viewer", owner.cookie);
    const show = await createShow(owner.cookie, "TP show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: team.id }));
    const people = (body: unknown, by: User) =>
      post(`/api/teams/${team.id}/people`, body, by.cookie);

    expect((await people({ email: known.email, role: "admin" }, editor)).status).toBe(403);
    expect((await people({ email: known.email, role: "viewer" }, viewer)).status).toBe(403);
    const added = await ok<AddTeamPeopleResponse>(
      people({ email: known.email, role: "commenter" }, editor),
      201,
    );
    expect(added).toMatchObject({
      added: { userId: known.id, role: "commenter", invitedBy: { id: editor.id } },
      emailed: false,
    });
    // They reach the team's shows at once.
    expect(
      (await ok<ShowResponse>(api(`/api/shows/${show.id}`, { cookie: known.cookie }))).role,
    ).toBe("commenter");
    expect((await people({ email: known.email, role: "viewer" }, owner)).status).toBe(409);

    const email = freshEmail("teamguest");
    const res = await ok<AddTeamPeopleResponse>(people({ email, role: "editor" }, editor), 201);
    if (!("invited" in res)) throw new Error("expected an invite");
    expect(await ok<InviteInfoResponse>(api(`/api/invites/${tokenOf(res.invited.path)}`))).toEqual({
      email,
      showName: null,
      role: null,
      teamName: "TP team",
      teamRole: "editor",
    });
    const joined = await accept(res.invited.path, "TP Guest");
    const list = await ok<TeamMembersResponse>(
      api(`/api/teams/${team.id}/members`, { cookie: owner.cookie }),
    );
    expect(list.members.find((m) => m.userId === joined.id)).toMatchObject({
      role: "editor",
      invitedBy: { id: editor.id, name: "TP Editor" },
    });
    expect(
      (await ok<ShowResponse>(api(`/api/shows/${show.id}`, { cookie: joined.cookie }))).role,
    ).toBe("editor");

    // Owner-only policy: editors can't.
    await ok(send("PATCH", `/api/teams/${team.id}`, owner.cookie, { invitePolicy: "owner" }));
    expect((await people({ email: freshEmail(), role: "viewer" }, editor)).status).toBe(403);
  });
});

describe("POST /api/invites with the new rules", () => {
  it("show or team targets (never both), delegated and capped; plain sign-ups stay admin-only", async () => {
    const admin = await loginAdmin();
    const { owner, editor, commenter, show } = await crew(admin, "Inv");
    const team = await createTeam(owner.cookie, "Inv team");
    const teamEditor = await newUser(admin, "Inv Team editor");
    await addToTeam(team.id, teamEditor, "editor", owner.cookie);
    const invite = (body: object, by: string) =>
      post("/api/invites", { email: freshEmail(), ...body }, by);

    expect((await invite({ showId: show.id, role: "editor" }, editor.cookie)).status).toBe(200);
    expect((await invite({ showId: show.id, role: "viewer" }, commenter.cookie)).status).toBe(403);
    expect((await invite({}, editor.cookie)).status).toBe(403);
    expect((await invite({ teamId: team.id, teamRole: "editor" }, teamEditor.cookie)).status).toBe(
      200,
    );
    expect((await invite({ teamId: team.id, teamRole: "admin" }, teamEditor.cookie)).status).toBe(
      403,
    );
    expect((await invite({ teamId: team.id, teamRole: "owner" }, owner.cookie)).status).toBe(400);
    expect((await invite({ teamId: team.id, teamRole: "viewer" }, editor.cookie)).status).toBe(403);
    expect(
      (
        await invite(
          { showId: show.id, role: "viewer", teamId: team.id, teamRole: "viewer" },
          admin,
        )
      ).status,
    ).toBe(400);
    expect((await invite({ teamId: "no-such-team", teamRole: "viewer" }, admin)).status).toBe(404);
    // Admins: anyone, anywhere.
    expect((await invite({ teamId: team.id, teamRole: "admin" }, admin)).status).toBe(200);
    const plain = await ok<CreateInviteResponse>(invite({}, admin));
    expect(plain.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pending invites: list, revoke, reissue", () => {
  it("show: managers see all, others their own; revoke and reissue kill the old link", async () => {
    const admin = await loginAdmin();
    const { owner, editor, viewer, show } = await crew(admin, "Pend");
    const other = await newUser(admin, "Pend Other editor");
    await addToShow(show.id, other, "editor", owner.cookie);
    const invite = async (by: User, role = "viewer") => {
      const res = await ok<AddShowPeopleResponse>(
        post(`/api/shows/${show.id}/people`, { email: freshEmail("pend"), role }, by.cookie),
        201,
      );
      if (!("invited" in res)) throw new Error("expected an invite");
      return res.invited;
    };
    const mine = await invite(editor);
    const theirs = await invite(other, "commenter");
    const owners = await invite(owner);
    const listPath = `/api/shows/${show.id}/invites`;

    const all = await pending(listPath, owner.cookie);
    expect(all.map((i) => i.id).sort()).toEqual([mine.id, theirs.id, owners.id].sort());
    expect(all.find((i) => i.id === theirs.id)).toMatchObject({
      email: theirs.email,
      role: "commenter",
      invitedBy: { id: other.id, name: "Pend Other editor" },
      expired: false,
    });
    expect((await pending(listPath, editor.cookie)).map((i) => i.id)).toEqual([mine.id]);
    expect(await pending(listPath, viewer.cookie)).toEqual([]);

    // Revoke: the inviter or the owner; another editor can't; strangers get 404.
    const outsider = await newUser(admin, "Pend Outsider");
    expect((await send("DELETE", `/api/invites/${mine.id}`, other.cookie)).status).toBe(403);
    expect((await send("DELETE", `/api/invites/${mine.id}`, outsider.cookie)).status).toBe(404);
    expect((await send("DELETE", `/api/invites/${mine.id}`, editor.cookie)).status).toBe(200);
    expect(await linkWorks(mine.path)).toBe(404);
    expect((await send("DELETE", `/api/invites/${mine.id}`, editor.cookie)).status).toBe(404);
    expect((await send("DELETE", `/api/invites/${theirs.id}`, owner.cookie)).status).toBe(200);
    expect((await pending(listPath, owner.cookie)).map((i) => i.id)).toEqual([owners.id]);
    const gone = await post(`/api/invites/${tokenOf(theirs.path)}/accept`, {
      name: "Late",
      password: PASSWORD,
    });
    expect(gone.status).toBe(404);

    // Reissue: same people; a new link and id, the old link dead, still listed once.
    expect((await post(`/api/invites/${owners.id}/reissue`, {}, editor.cookie)).status).toBe(403);
    const again = await ok<ReissueInviteResponse>(
      post(`/api/invites/${owners.id}/reissue`, {}, owner.cookie),
    );
    expect(again.id).not.toBe(owners.id);
    expect(again.emailed).toBe(false);
    expect(await linkWorks(owners.path)).toBe(404);
    expect(await linkWorks(again.path)).toBe(200);
    const after = await pending(listPath, owner.cookie);
    expect(after.map((i) => [i.id, i.email])).toEqual([[again.id, owners.email]]);
    expect((await post(`/api/invites/${owners.id}/reissue`, {}, owner.cookie)).status).toBe(404);
  });

  it("expired invites stay listed (and reissuable) for 30 days", async () => {
    const admin = await loginAdmin();
    const { owner, show } = await crew(admin, "Exp");
    const make = async () => {
      const res = await ok<AddShowPeopleResponse>(
        post(
          `/api/shows/${show.id}/people`,
          { email: freshEmail("exp"), role: "viewer" },
          owner.cookie,
        ),
        201,
      );
      return (res as { invited: InvitedDTO }).invited;
    };
    const recent = await make();
    const old = await make();
    const age = (id: string, ms: number) =>
      env.DB.prepare("UPDATE invites SET expires_at = ?1 WHERE id = ?2")
        .bind(Date.now() - ms, id)
        .run();
    await age(recent.id, 86_400_000);
    await age(old.id, 31 * 86_400_000);
    const list = await pending(`/api/shows/${show.id}/invites`, owner.cookie);
    expect(list.map((i) => [i.id, i.expired])).toEqual([[recent.id, true]]);
    expect(await linkWorks(recent.path)).toBe(404);
    const fresh = await ok<ReissueInviteResponse>(
      post(`/api/invites/${recent.id}/reissue`, {}, owner.cookie),
    );
    expect(await linkWorks(fresh.path)).toBe(200);
  });

  it("team: managers see and revoke all, editors their own", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "TPend Owner");
    const teamAdmin = await newUser(admin, "TPend Admin");
    const editor = await newUser(admin, "TPend Editor");
    const other = await newUser(admin, "TPend Other");
    const team = await createTeam(owner.cookie, "TPend team");
    await addToTeam(team.id, teamAdmin, "admin", owner.cookie);
    await addToTeam(team.id, editor, "editor", owner.cookie);
    await addToTeam(team.id, other, "editor", owner.cookie);
    const invite = async (by: User) =>
      (
        (await ok<AddTeamPeopleResponse>(
          post(
            `/api/teams/${team.id}/people`,
            { email: freshEmail("tp"), role: "viewer" },
            by.cookie,
          ),
          201,
        )) as { invited: InvitedDTO }
      ).invited;
    const mine = await invite(editor);
    const theirs = await invite(other);
    const listPath = `/api/teams/${team.id}/invites`;
    expect((await pending(listPath, teamAdmin.cookie)).map((i) => i.id).sort()).toEqual(
      [mine.id, theirs.id].sort(),
    );
    expect((await pending(listPath, editor.cookie)).map((i) => i.id)).toEqual([mine.id]);
    expect((await send("DELETE", `/api/invites/${theirs.id}`, editor.cookie)).status).toBe(403);
    expect((await send("DELETE", `/api/invites/${theirs.id}`, teamAdmin.cookie)).status).toBe(200);
    expect(await linkWorks(theirs.path)).toBe(404);
    expect((await post(`/api/invites/${mine.id}/reissue`, {}, editor.cookie)).status).toBe(200);
  });

  it("removing someone ends their open invites into that show or team", async () => {
    const admin = await loginAdmin();
    const { owner, editor, show } = await crew(admin, "Rm");
    const team = await createTeam(owner.cookie, "Rm team");
    const teamEditor = await newUser(admin, "Rm Team editor");
    await addToTeam(team.id, teamEditor, "editor", owner.cookie);
    const showInvite = (
      (await ok<AddShowPeopleResponse>(
        post(
          `/api/shows/${show.id}/people`,
          { email: freshEmail("rm"), role: "viewer" },
          editor.cookie,
        ),
        201,
      )) as { invited: InvitedDTO }
    ).invited;
    const teamInvite = (
      (await ok<AddTeamPeopleResponse>(
        post(
          `/api/teams/${team.id}/people`,
          { email: freshEmail("rmt"), role: "viewer" },
          teamEditor.cookie,
        ),
        201,
      )) as { invited: InvitedDTO }
    ).invited;
    await ok(send("DELETE", `/api/shows/${show.id}/members/${editor.id}`, owner.cookie));
    await ok(send("DELETE", `/api/teams/${team.id}/members/${teamEditor.id}`, owner.cookie));
    expect(await linkWorks(showInvite.path)).toBe(404);
    expect(await linkWorks(teamInvite.path)).toBe(404);
    expect(await pending(`/api/shows/${show.id}/invites`, owner.cookie)).toEqual([]);
    expect(await pending(`/api/teams/${team.id}/invites`, owner.cookie)).toEqual([]);
  });
});

describe("the per-inviter limit", () => {
  it("30 invites an hour per inviter (429); admins aren't limited", async () => {
    const admin = await loginAdmin();
    const { owner, show } = await crew(admin, "Lim");
    const now = Date.now();
    for (let i = 0; i < 30; i++) await recordFailure(env.DB, [inviteLimits(owner.id)], now - i);
    const res = await post(
      `/api/shows/${show.id}/people`,
      { email: freshEmail("lim"), role: "viewer" },
      owner.cookie,
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(
      (await post("/api/invites", { email: freshEmail(), showId: show.id }, owner.cookie)).status,
    ).toBe(429);
    // Adding an existing account isn't an invite: not limited.
    const known = await newUser(admin, "Lim Known");
    expect(
      (
        await post(
          `/api/shows/${show.id}/people`,
          { email: known.email, role: "viewer" },
          owner.cookie,
        )
      ).status,
    ).toBe(201);
    // Each invite counts.
    const { owner: o2, show: s2 } = await crew(admin, "Lim2");
    for (let i = 0; i < 30; i++) {
      await ok(
        post(`/api/shows/${s2.id}/people`, { email: freshEmail("l2"), role: "viewer" }, o2.cookie),
        201,
      );
    }
    expect(
      (
        await post(
          `/api/shows/${s2.id}/people`,
          { email: freshEmail("l2"), role: "viewer" },
          o2.cookie,
        )
      ).status,
    ).toBe(429);
  });
});

describe("people and my access", () => {
  it("GET /api/people: everyone sharing a show or team with me, not me, by name", async () => {
    const admin = await loginAdmin();
    const me = await newUser(admin, "Pp Me");
    const showmate = await newUser(admin, "Pp Bshow");
    const teammate = await newUser(admin, "Pp Ateam");
    const guestOfTeamShow = await newUser(admin, "Pp Cguest");
    const stranger = await newUser(admin, "Pp Stranger");
    const show = await createShow(me.cookie, "Pp show");
    await addToShow(show.id, showmate, "viewer", me.cookie);
    const team = await createTeam(me.cookie, "Pp team");
    await addToTeam(team.id, teammate, "editor", me.cookie);
    const teamShow = await createShow(teammate.cookie, "Pp team show");
    await addToShow(teamShow.id, guestOfTeamShow, "viewer", teammate.cookie);
    await ok(send("PATCH", `/api/shows/${teamShow.id}`, teammate.cookie, { teamId: team.id }));
    const strangerShow = await createShow(stranger.cookie, "Pp stranger show");
    expect(strangerShow.id).toBeTruthy();

    const { people } = await ok<PeopleResponse>(api("/api/people", { cookie: me.cookie }));
    expect(people).toEqual([
      { id: teammate.id, name: "Pp Ateam", email: teammate.email },
      { id: showmate.id, name: "Pp Bshow", email: showmate.email },
      { id: guestOfTeamShow.id, name: "Pp Cguest", email: guestOfTeamShow.email },
    ]);
    expect((await api("/api/people")).status).toBe(401);
  });

  it("GET /api/me/access: my teams (role, show count) and shows (role, source)", async () => {
    const admin = await loginAdmin();
    const me = await newUser(admin, "Acc Me");
    const lead = await newUser(admin, "Acc Lead");
    const team = await createTeam(lead.cookie, "Acc team");
    await addToTeam(team.id, me, "commenter", lead.cookie);
    const teamShow = await createShow(lead.cookie, "Acc team show");
    await ok(send("PATCH", `/api/shows/${teamShow.id}`, lead.cookie, { teamId: team.id }));
    const guestShow = await createShow(lead.cookie, "Acc guest show");
    await addToShow(guestShow.id, me, "editor", lead.cookie);
    const own = await createShow(me.cookie, "Acc own show");

    const access = await ok<MyAccessResponse>(api("/api/me/access", { cookie: me.cookie }));
    expect(access.teams).toEqual([
      { id: team.id, name: "Acc team", role: "commenter", showCount: 1 },
    ]);
    const shows = Object.fromEntries(access.shows.map((s) => [s.name, s]));
    expect(shows["Acc team show"]).toMatchObject({
      role: "commenter",
      source: "team",
      teamId: team.id,
      teamName: "Acc team",
    });
    expect(shows["Acc guest show"]).toMatchObject({
      role: "editor",
      source: "direct",
      teamId: null,
    });
    expect(shows["Acc own show"]).toMatchObject({ id: own.id, role: "owner", source: "direct" });
  });

  it("last_active_at: set on a signed-in request when unset or over an hour old", async () => {
    const admin = await loginAdmin();
    const user = await newUser(admin, "Active");
    const read = async () =>
      (
        await env.DB.prepare("SELECT last_active_at AS t FROM users WHERE id = ?")
          .bind(user.id)
          .first<{ t: number | null }>()
      )?.t ?? null;
    const set = (t: number | null) =>
      env.DB.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").bind(t, user.id).run();
    await set(null);
    await api("/api/shows", { cookie: user.cookie });
    expect(await read()).toBeGreaterThan(Date.now() - 60_000);
    const recent = Date.now() - 10 * 60_000;
    await set(recent);
    await api("/api/shows", { cookie: user.cookie });
    expect(await read()).toBe(recent);
    await set(Date.now() - 2 * 3_600_000);
    await api("/api/shows", { cookie: user.cookie });
    expect(await read()).toBeGreaterThan(Date.now() - 60_000);
    const listed = await members((await createShow(user.cookie, "Active show")).id, user.cookie);
    expect(listed[0]?.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("email", () => {
  it("invite and added emails: who, what, role, link; sent through Resend with the key", async () => {
    const admin = await loginAdmin();
    const { owner, editor, show } = await crew(admin, "Mail <b>&");
    const known = await newUser(admin, "Mail Known");
    const resend = stubResend();
    try {
      const email = freshEmail("mail");
      const res = await ok<AddShowPeopleResponse>(
        post(`/api/shows/${show.id}/people`, { email, role: "commenter" }, editor.cookie),
        201,
      );
      if (!("invited" in res)) throw new Error("expected an invite");
      expect(res.emailed).toBe(true);
      expect(resend.sent).toHaveLength(1);
      const [mail] = resend.sent;
      expect(mail?.url).toBe("https://api.resend.com/emails");
      expect(mail?.authorization).toBe("Bearer re_test_key");
      expect(mail?.body.from).toBe("Cuesheet <cuesheet@easyschematic.live>");
      expect(mail?.body.to).toBe(email);
      // Replies reach the inviter; each invite is its own thread (its id as the ref).
      expect(mail?.body.reply_to).toBe(editor.email);
      expect(mail?.body.headers).toEqual({ "X-Entity-Ref-ID": res.invited.id });
      expect(mail?.body.subject).toBe("Mail <b>& Editor invited you to Mail <b>& show on Cuesheet");
      const link = `http://localhost${res.invited.path}`;
      for (const part of [link, "Mail <b>& Editor", "Mail <b>& show", "commenter"]) {
        expect(mail?.body.text).toContain(part);
      }
      expect(mail?.body.text).toMatch(/expires/i);
      expect(mail?.body.html).toContain(`href="${link}"`);
      expect(mail?.body.html).toContain("Mail &lt;b&gt;&amp; show");
      expect(mail?.body.html).not.toContain("<b>&");

      const added = await ok<AddShowPeopleResponse>(
        post(`/api/shows/${show.id}/people`, { email: known.email, role: "viewer" }, owner.cookie),
        201,
      );
      expect(added.emailed).toBe(true);
      const second = resend.sent[1];
      expect(second?.body.to).toBe(known.email);
      expect(second?.body.reply_to).toBe(owner.email);
      expect(second?.body.headers["X-Entity-Ref-ID"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(second?.body.subject).toBe("Mail <b>& Owner added you to Mail <b>& show on Cuesheet");
      expect(second?.body.text).toContain(`http://localhost/shows/${show.id}`);
      expect(second?.body.text).toContain("viewer");

      // Reissue re-sends; APP_ORIGIN, when set, is the link's origin.
      const vars = env as unknown as Record<string, string | undefined>;
      vars.APP_ORIGIN = "https://cues.example";
      try {
        const again = await ok<ReissueInviteResponse>(
          post(`/api/invites/${res.invited.id}/reissue`, {}, editor.cookie),
        );
        expect(again.emailed).toBe(true);
        expect(resend.sent[2]?.body.to).toBe(email);
        expect(resend.sent[2]?.body.headers).toEqual({ "X-Entity-Ref-ID": again.id });
        expect(resend.sent[2]?.body.text).toContain(`https://cues.example${again.path}`);
      } finally {
        delete vars.APP_ORIGIN;
      }

      // A team: the team's name and role; the link to the team page.
      const team = await createTeam(owner.cookie, "Mail team");
      await ok(
        post(`/api/teams/${team.id}/people`, { email: known.email, role: "admin" }, owner.cookie),
        201,
      );
      expect(resend.sent[3]?.body.subject).toBe(
        "Mail <b>& Owner added you to Mail team on Cuesheet",
      );
      expect(resend.sent[3]?.body.text).toContain(`http://localhost/teams/${team.id}`);
      expect(resend.sent[3]?.body.text).toContain("admin");
    } finally {
      resend.restore();
    }
  });

  it("no key: nothing is sent; a failed send still succeeds with emailed:false", async () => {
    const admin = await loginAdmin();
    const { owner, show } = await crew(admin, "NoMail");
    const people = () =>
      post(
        `/api/shows/${show.id}/people`,
        { email: freshEmail("nm"), role: "viewer" },
        owner.cookie,
      );
    for (const fail of ["status", "throw"] as const) {
      const resend = stubResend({ fail });
      try {
        const res = await ok<AddShowPeopleResponse>(people(), 201);
        expect(res.emailed, fail).toBe(false);
        expect(resend.sent).toHaveLength(1);
        if ("invited" in res) expect(await linkWorks(res.invited.path)).toBe(200);
      } finally {
        resend.restore();
      }
    }
    // Without RESEND_API_KEY no request is made at all.
    const resend = stubResend();
    const vars = env as unknown as Record<string, string | undefined>;
    delete vars.RESEND_API_KEY;
    try {
      const res = await ok<AddShowPeopleResponse>(people(), 201);
      expect(res.emailed).toBe(false);
      expect(resend.sent).toHaveLength(0);
    } finally {
      resend.restore();
    }
  });
});
