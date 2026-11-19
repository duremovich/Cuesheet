// Review fixes for teams and delegated invites: invites never outlive their inviter's
// rights (reissue, accept, cleanup when access goes), no adding yourself, leave and
// role-change races, the foreign keys' ON DELETE actions, the email timeout, and what a
// share link's viewer learns about the show.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  AddShowPeopleResponse,
  InvitedDTO,
  MembersResponse,
  PendingInvitesResponse,
  ReissueInviteResponse,
  TeamDTO,
  TeamRole,
} from "../../src/shared/api";
import { sendEmail } from "../../src/worker/email";
import { api, createShow, loginAdmin, newUser, post, stubResend } from "./helpers";

type User = Awaited<ReturnType<typeof newUser>>;
const PASSWORD = "long-enough-pw";
let seq = 0;
const freshEmail = (tag = "h") => `${tag}${Date.now().toString(36)}${seq++}@test.local`;

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  api(path, { method, cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function createTeam(cookie: string, name: string): Promise<TeamDTO> {
  return (await ok<{ team: TeamDTO }>(post("/api/teams", { name }, cookie), 201)).team;
}

async function addToTeam(teamId: string, user: User, role: TeamRole, cookie: string) {
  await ok(post(`/api/teams/${teamId}/members`, { email: user.email, role }, cookie), 201);
}

async function addToShow(showId: string, user: User, role: string, cookie: string) {
  await ok(post(`/api/shows/${showId}/members`, { email: user.email, role }, cookie), 201);
}

async function inviteToShow(showId: string, by: User, role = "viewer"): Promise<InvitedDTO> {
  const res = await ok<AddShowPeopleResponse>(
    post(`/api/shows/${showId}/people`, { email: freshEmail(), role }, by.cookie),
    201,
  );
  if (!("invited" in res)) throw new Error("expected an invite");
  return res.invited;
}

const tokenOf = (path: string) => path.split("/").at(-1) as string;

function acceptFrom(ip: string, path: string) {
  return api(`/api/invites/${tokenOf(path)}/accept`, {
    method: "POST",
    body: JSON.stringify({ name: "Joiner", password: PASSWORD }),
    headers: { "CF-Connecting-IP": ip },
  });
}

async function failuresFor(ip: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limit_events WHERE key = ?")
    .bind(`invite:ip:${ip}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function pendingIds(path: string, cookie: string): Promise<string[]> {
  return (await ok<PendingInvitesResponse>(api(path, { cookie }))).invites.map((i) => i.id);
}

describe("invites never outlive their inviter's rights", () => {
  it("a demoted editor (now viewer) can't reissue; their open invite can't be accepted", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "H1 Owner");
    const editor = await newUser(admin, "H1 Editor");
    const show = await createShow(owner.cookie, "H1 show");
    await addToShow(show.id, editor, "editor", owner.cookie);
    const invite = await inviteToShow(show.id, editor, "commenter");
    await ok(
      send("PATCH", `/api/shows/${show.id}/members/${editor.id}`, owner.cookie, { role: "viewer" }),
    );

    expect((await post(`/api/invites/${invite.id}/reissue`, {}, editor.cookie)).status).toBe(403);
    const ip = "198.51.100.71";
    const refused = await acceptFrom(ip, invite.path);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "This invite link is invalid or has been used" });
    // Not the invitee's fault: no rate-limit failure counted.
    expect(await failuresFor(ip)).toBe(0);
    // The owner reissues it: the owner becomes its inviter (the editor can't grant any
    // more), so the new link works.
    const again = await ok<ReissueInviteResponse>(
      post(`/api/invites/${invite.id}/reissue`, {}, owner.cookie),
    );
    expect((await acceptFrom(ip, again.path)).status).toBe(201);
    const members = (
      await ok<MembersResponse>(api(`/api/shows/${show.id}/members`, { cookie: owner.cookie }))
    ).members;
    expect(members.find((m) => m.name === "Joiner")?.invitedBy?.id).toBe(owner.id);
  });

  it("policy switched to owner: the editor can't reissue and their invite can't be accepted; revoking stays theirs", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "H2 Owner");
    const editor = await newUser(admin, "H2 Editor");
    const show = await createShow(owner.cookie, "H2 show");
    await addToShow(show.id, editor, "editor", owner.cookie);
    const invite = await inviteToShow(show.id, editor);
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { invitePolicy: "owner" }));
    expect((await post(`/api/invites/${invite.id}/reissue`, {}, editor.cookie)).status).toBe(403);
    expect((await api(`/api/invites/${tokenOf(invite.path)}`)).status).toBe(404);
    expect((await acceptFrom("198.51.100.72", invite.path)).status).toBe(404);
    expect((await send("DELETE", `/api/invites/${invite.id}`, editor.cookie)).status).toBe(200);
  });

  it("a removed team editor's earlier invite into a team show ends, and they can't reissue it", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "H3 Owner");
    const editor = await newUser(admin, "H3 Editor");
    const team = await createTeam(owner.cookie, "H3 team");
    await addToTeam(team.id, editor, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "H3 show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: team.id }));
    const invite = await inviteToShow(show.id, editor);
    await ok(send("DELETE", `/api/teams/${team.id}/members/${editor.id}`, owner.cookie));
    expect((await acceptFrom("198.51.100.73", invite.path)).status).toBe(404);
    expect((await post(`/api/invites/${invite.id}/reissue`, {}, editor.cookie)).status).toBe(404);
    expect(await pendingIds(`/api/shows/${show.id}/invites`, owner.cookie)).toEqual([]);
  });

  it("leaving a team ends your invites into its shows you can no longer open (not the others)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "H4 Owner");
    const editor = await newUser(admin, "H4 Editor");
    const team = await createTeam(owner.cookie, "H4 team");
    await addToTeam(team.id, editor, "editor", owner.cookie);
    const gone = await createShow(owner.cookie, "H4 gone");
    const kept = await createShow(owner.cookie, "H4 kept");
    for (const s of [gone, kept]) {
      await ok(send("PATCH", `/api/shows/${s.id}`, owner.cookie, { teamId: team.id }));
    }
    await addToShow(kept.id, editor, "editor", owner.cookie); // a direct member too
    const lost = await inviteToShow(gone.id, editor);
    const still = await inviteToShow(kept.id, editor);
    await ok(post(`/api/teams/${team.id}/leave`, {}, editor.cookie));
    expect(await pendingIds(`/api/shows/${gone.id}/invites`, owner.cookie)).toEqual([]);
    expect(await pendingIds(`/api/shows/${kept.id}/invites`, owner.cookie)).toEqual([still.id]);
    expect((await api(`/api/invites/${tokenOf(lost.path)}`)).status).toBe(404);
  });

  it("a show moved out of its team ends the invites of whoever lost access to it", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "H5 Owner");
    const teamEditor = await newUser(admin, "H5 Team editor");
    const team = await createTeam(owner.cookie, "H5 team");
    await addToTeam(team.id, teamEditor, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "H5 show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: team.id }));
    const theirs = await inviteToShow(show.id, teamEditor);
    const mine = await inviteToShow(show.id, owner);
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: null }));
    expect(await pendingIds(`/api/shows/${show.id}/invites`, owner.cookie)).toEqual([mine.id]);
    expect((await api(`/api/invites/${tokenOf(theirs.path)}`)).status).toBe(404);
  });
});

describe("no adding yourself", () => {
  it("show and team members / people: 400 for your own email", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "Self Owner");
    const show = await createShow(owner.cookie, "Self show");
    const team = await createTeam(owner.cookie, "Self team");
    for (const path of [
      `/api/shows/${show.id}/members`,
      `/api/shows/${show.id}/people`,
      `/api/teams/${team.id}/members`,
      `/api/teams/${team.id}/people`,
    ]) {
      const res = await post(
        path,
        { email: owner.email.toUpperCase(), role: "viewer" },
        owner.cookie,
      );
      expect(res.status, path).toBe(400);
    }
  });
});

describe("races", () => {
  it("two leaves at once: exactly one succeeds (team and show)", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "Race Owner");
    const member = await newUser(admin, "Race Member");
    const team = await createTeam(owner.cookie, "Race team");
    await addToTeam(team.id, member, "editor", owner.cookie);
    const show = await createShow(owner.cookie, "Race show");
    await addToShow(show.id, member, "editor", owner.cookie);
    for (const path of [`/api/teams/${team.id}/leave`, `/api/shows/${show.id}/leave`]) {
      const statuses = (
        await Promise.all([post(path, {}, member.cookie), post(path, {}, member.cookie)])
      )
        .map((r) => r.status)
        .sort();
      // The loser either saw them gone already (404) or lost the delete (409); never 200.
      expect(statuses[0], path).toBe(200);
      expect([404, 409], path).toContain(statuses[1]);
    }
  });
});

describe("foreign keys act on delete", () => {
  it("team → its invites cascade; a team with shows can't go; an inviter → invited_by null", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "FK Owner");
    const team = await createTeam(owner.cookie, "FK team");
    await ok(
      post(`/api/teams/${team.id}/people`, { email: freshEmail(), role: "viewer" }, owner.cookie),
      201,
    );
    const count = async (sql: string, ...args: unknown[]) =>
      (
        await env.DB.prepare(sql)
          .bind(...args)
          .first<{ n: number }>()
      )?.n ?? 0;
    expect(await count("SELECT COUNT(*) AS n FROM invites WHERE team_id = ?", team.id)).toBe(1);
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(team.id).run();
    expect(await count("SELECT COUNT(*) AS n FROM invites WHERE team_id = ?", team.id)).toBe(0);

    const busy = await createTeam(owner.cookie, "FK busy");
    const show = await createShow(owner.cookie, "FK show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: busy.id }));
    await expect(
      env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(busy.id).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    // An inviter who goes (users are never deleted by the app; this is the database's rule).
    const inviter = await newUser(admin, "FK Inviter");
    const invitee = await newUser(admin, "FK Invitee");
    await addToShow(show.id, inviter, "editor", owner.cookie);
    await addToShow(show.id, invitee, "viewer", inviter.cookie);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(inviter.id).run();
    const row = await env.DB.prepare(
      "SELECT invited_by AS b FROM memberships WHERE show_id = ? AND user_id = ?",
    )
      .bind(show.id, invitee.id)
      .first<{ b: string | null }>();
    expect(row).toEqual({ b: null });
  });
});

describe("email", () => {
  it("gives up after the timeout: emailed false, never hangs", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    try {
      const message = {
        to: "x@test.local",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        replyTo: "y@test.local",
        refId: "r",
      };
      const started = Date.now();
      expect(await sendEmail({ RESEND_API_KEY: "k" }, message, { timeoutMs: 50 })).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(spy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });

  it("the routes send with a timeout signal", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "Sig Owner");
    const show = await createShow(owner.cookie, "Sig show");
    const resend = stubResend();
    try {
      await inviteToShow(show.id, owner);
      expect(resend.sent[0]?.hasSignal).toBe(true);
    } finally {
      resend.restore();
    }
  });
});

describe("share links", () => {
  it("GET /shows/:id through a share link leaves out the team and the invite policy", async () => {
    const admin = await loginAdmin();
    const owner = await newUser(admin, "Sh Owner");
    const team = await createTeam(owner.cookie, "Sh team");
    const show = await createShow(owner.cookie, "Sh show");
    await ok(send("PATCH", `/api/shows/${show.id}`, owner.cookie, { teamId: team.id }));
    const link = await ok<{ path: string }>(
      post(`/api/shows/${show.id}/share-links`, { kind: "view", table: "cues" }, owner.cookie),
      201,
    );
    const res = await ok<{ show: Record<string, unknown>; role: string }>(
      api(`/api/shows/${show.id}`, { cookie: `cs_share=${tokenOf(link.path)}` }),
    );
    expect(res.role).toBe("viewer");
    expect(res.show).not.toHaveProperty("teamId");
    expect(res.show).not.toHaveProperty("teamName");
    expect(res.show).not.toHaveProperty("invitePolicy");
    // Members still get them.
    const member = await ok<{ show: Record<string, unknown> }>(
      api(`/api/shows/${show.id}`, { cookie: owner.cookie }),
    );
    expect(member.show).toMatchObject({
      teamId: team.id,
      teamName: "Sh team",
      invitePolicy: "editors",
    });
  });
});

describe("team owner/admins manage their team shows' guests", () => {
  /** A team show whose owner is a team editor, a direct editor who added a guest, then left. */
  async function setup(tag: string) {
    const admin = await loginAdmin();
    const lead = await newUser(admin, `${tag} Team owner`);
    const teamAdmin = await newUser(admin, `${tag} Team admin`);
    const teamEditor = await newUser(admin, `${tag} Team editor`);
    const showOwner = await newUser(admin, `${tag} Show owner`);
    const departed = await newUser(admin, `${tag} Departed`);
    const guest = await newUser(admin, `${tag} Guest`);
    const team = await createTeam(lead.cookie, `${tag} team`);
    await addToTeam(team.id, teamAdmin, "admin", lead.cookie);
    await addToTeam(team.id, teamEditor, "editor", lead.cookie);
    await addToTeam(team.id, showOwner, "editor", lead.cookie);
    const show = await createShow(showOwner.cookie, `${tag} show`);
    await ok(send("PATCH", `/api/shows/${show.id}`, showOwner.cookie, { teamId: team.id }));
    await addToShow(show.id, departed, "editor", showOwner.cookie);
    await addToShow(show.id, guest, "viewer", departed.cookie);
    return { lead, teamAdmin, teamEditor, showOwner, departed, guest, show };
  }

  it("an admin changes and removes a guest invited by a departed editor; never the show's owner", async () => {
    const { lead, teamAdmin, showOwner, departed, guest, show } = await setup("TG1");
    const invite = await inviteToShow(show.id, departed);
    await ok(post(`/api/shows/${show.id}/leave`, {}, departed.cookie));
    const member = (u: User) => `/api/shows/${show.id}/members/${u.id}`;
    expect((await send("PATCH", member(guest), teamAdmin.cookie, { role: "editor" })).status).toBe(
      200,
    );
    expect((await send("PATCH", member(guest), teamAdmin.cookie, { role: "owner" })).status).toBe(
      400,
    );
    expect((await send("PATCH", member(showOwner), lead.cookie, { role: "viewer" })).status).toBe(
      400,
    );
    expect((await send("DELETE", member(showOwner), teamAdmin.cookie)).status).toBe(400);
    expect((await send("DELETE", member(guest), teamAdmin.cookie)).status).toBe(200);
    // The departed editor's invites ended when they left; a fresh one by the show's owner
    // is visible to the team's admins and revocable by them.
    expect(invite.id).toBeTruthy();
    const pending = await inviteToShow(show.id, showOwner);
    expect(await pendingIds(`/api/shows/${show.id}/invites`, teamAdmin.cookie)).toEqual([
      pending.id,
    ]);
    // …and reissue it (the show's owner can still make it, so it stays theirs and works).
    const again = await ok<ReissueInviteResponse>(
      post(`/api/invites/${pending.id}/reissue`, {}, teamAdmin.cookie),
    );
    expect((await api(`/api/invites/${tokenOf(again.path)}`)).status).toBe(200);
    expect((await send("DELETE", `/api/invites/${again.id}`, teamAdmin.cookie)).status).toBe(200);
    expect(await pendingIds(`/api/shows/${show.id}/invites`, showOwner.cookie)).toEqual([]);
  });

  it("a team editor removing someone else's guest is still refused, and sees only their own invites", async () => {
    const { teamEditor, showOwner, guest, show } = await setup("TG2");
    await inviteToShow(show.id, showOwner);
    expect(
      (await send("DELETE", `/api/shows/${show.id}/members/${guest.id}`, teamEditor.cookie)).status,
    ).toBe(403);
    expect(
      (
        await send("PATCH", `/api/shows/${show.id}/members/${guest.id}`, teamEditor.cookie, {
          role: "commenter",
        })
      ).status,
    ).toBe(403);
    expect(await pendingIds(`/api/shows/${show.id}/invites`, teamEditor.cookie)).toEqual([]);
  });
});
