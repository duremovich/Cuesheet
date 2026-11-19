# Plan: teams, delegated invites, invite email, access QoL (2026-11-18)

Branch `teams-invites`, worktree `.claude/worktrees/teams-invites`. Working plan only: delete this
file before merging; the durable record is `docs/decisions/0010-teams-and-delegated-invites.md`
plus the CLAUDE.md / spec updates listed at the end.

Why: Dylan is inviting outside collaborators. Today only a show's owner (or an instance admin)
can invite, there are no teams, invites are copy-link only, and nobody can see or revoke a
pending invite.

## Decisions (made with Dylan; don't relitigate)

1. **Real teams.** A team is a set of people with a team role. A show belongs to at most one
   team (`shows.team_id`, nullable = personal). Team members get a derived role on every show of
   the team, including shows added later. People added straight to a show are "guests" (direct
   members, as today).
2. **Team roles:** `owner` (exactly one; the creator; transfers like shows), `admin`, `editor`,
   `commenter`, `viewer`. The show role derived from a team role is `owner`/`admin` → `editor`,
   otherwise the same name. Team owner/admin don't become show owners: a show still has exactly
   one owner, a direct member, as today ("Co-owners: no" still holds).
3. **Effective show role = the highest of the direct membership role and the team-derived role**
   (rank owner > editor > commenter > viewer). There is no show-level *downgrade* of a team
   member: to give someone less, change their team role or make them a guest instead.
4. **Delegated inviting, capped.** Who may invite:
   - Show: the owner always; members whose effective role is `editor` too, unless the owner set
     the show's `invite_policy` to `owner`. Nobody grants above their own role (editors grant
     editor/commenter/viewer; commenters/viewers never invite).
   - Team: owner and admins always; team editors too unless the team's `invite_policy` is
     `owner` (owner + admins only). Admins grant up to admin; editors up to editor; nobody grants
     owner (that's transfer).
   - **Control over your invitees:** a non-owner/non-admin inviter can change the role of (within
     their cap) and remove the people *they* invited (`invited_by` = them), and revoke/reissue
     their own pending invites. Show owners manage every direct member; team owner/admins manage
     every team member except the owner. Admins can manage other admins.
5. **Email via Resend**, optional: `RESEND_API_KEY` secret + `EMAIL_FROM` var (default
   `Cuesheet <cuesheet@easyschematic.live>`; Resend free plan = one domain, and
   easyschematic.live is already verified there). No key → no email, everything still works by
   copy-link. Email failure never fails the request: the response says `emailed: false`.
6. **QoL in this pass:** pending-invites list (revoke, reissue), member details (invited by,
   joined, last active, "people you've worked with" autocomplete), a "My access" account page.
   *Not* in this pass: bulk invite (several emails / several shows at once).
7. **Account oracle:** the existing Members UI already tells an owner whether an email has an
   account. Widening that to editors is accepted for a small invite-only instance; note it in the
   decision record. Public sign-up stays off.

## Data model (D1 migration `0006_teams_invites.sql`, via `pnpm db:generate`)

- `teams(id, name, created_by → users, created_at, invite_policy 'editors'|'owner' default 'editors')`
- `team_memberships(team_id → teams cascade, user_id → users cascade, role
  'owner'|'admin'|'editor'|'commenter'|'viewer', invited_by → users set null, created_at;
  PK(team_id, user_id); index on user_id)`
- `shows`: `team_id → teams` (nullable; `on delete restrict`: a team with shows can't be deleted),
  `invite_policy` ('editors'|'owner', default 'editors'); index on team_id.
- `memberships`: `invited_by` (nullable → users set null). Existing rows: null.
- `users`: `last_active_at` (nullable). Touched by `sessionOf` when null or > 1 h old (one
  conditional UPDATE, no extra read).
- `invites`: `team_id` (nullable → teams cascade), `team_role` (team role enum, nullable). An
  invite targets a show (`show_id` + `role`), a team (`team_id` + `team_role`), or neither (admin
  plain sign-up). Never both.
- Add `UNDO_MIGRATION` entries (`test/worker/helpers.ts`) per the repo's migration rule.

## Access core (one place)

- `src/worker/access.ts` (new): `effectiveRole(db, showId, userId)`, `showRoleFromTeamRole`,
  `maxRole`, `canGrant(actorRole, role)`, and `refreshAccess(env, db, {showIds, userIds})`: for
  each pair recompute the effective role; none → `ShowDO.disconnectUser`, else `notifyRole`.
  Call it after every change that can move access: team member add/role change/remove/leave,
  show moved into/out of a team, team transfer, direct member removal when the user also has team
  access (they keep the team role: notify, don't disconnect).
- `requireMembership` resolves through it (left joins on memberships and team_memberships; one
  query). `GET /shows` lists direct + team shows with `role` (effective), `teamId`, `teamName`.
  `session.ts` (the show ids used by logout-all disconnect) includes team shows.
- Read every other `memberships` use (`grep -rn memberships src/worker`): backup, clone,
  transfer, share, script, attachments, invites. Each either gets the effective role from
  `c.var.role` already or needs an explicit decision. Backup/export: direct members + `teamId`/
  `teamName`. Instance transfer (`routes/transfer.ts`, migrate-show): a team show arrives at the
  other instance as personal; document it, don't build team migration.

## API (Hono, JSON `{error}`; follow the existing route style and status codes)

Teams (`src/worker/routes/teams.ts`, new):
- `GET /api/teams` (mine, with my role), `POST /api/teams {name}` (any user; you're owner),
  `GET /api/teams/:id` (members only; 404 otherwise, same as shows), `PATCH /api/teams/:id
  {name?, invitePolicy?}` (owner/admin), `DELETE /api/teams/:id` (owner; 409 while it has shows).
- `GET /api/teams/:id/members` → `{userId, name, email, role, invitedBy:{id,name}|null,
  joinedAt, lastActiveAt}`; `PATCH/DELETE /api/teams/:id/members/:userId` (rules in decision 4);
  `POST /api/teams/:id/leave` (not the owner); `POST /api/teams/:id/transfer {userId|email}`
  (owner → that member becomes owner, old owner admin; one D1 batch that re-checks both sides,
  like `transferOwnership`).
- `GET /api/teams/:id/shows`.

Shows:
- `POST /api/shows {name, teamId?}`: with a team, the creator must be a team editor+.
- `PATCH /api/shows/:id {teamId: string|null}`: show owner. Moving in needs team editor+ in the
  target team. Team owner/admin may also set `teamId: null` on a show of their team. Then
  `refreshAccess`. `invitePolicy` through the same PATCH (owner).
- `GET /api/shows/:id/members` adds `invitedBy`, `joinedAt`, `lastActiveAt`, `source:
  'direct'|'team'` and, for team rows, `teamRole`. List direct members plus team members (team
  rows whose effective role comes from the team). A user with both shows once, with the effective
  role and both sources.
- Existing `POST/PATCH/DELETE /api/shows/:id/members` follow decision 4 instead of owner-only.
  Changing/removing a team-derived member here is 409 "Manage this person in the team".

One-step "add people" (what the UI calls):
- `POST /api/shows/:id/people {email, role}` and `POST /api/teams/:id/people {email, role}`.
  Account exists → added now (`invited_by` = you), "you were added" email, `{added: member,
  emailed}`. No account → invite created, invite email, `{invited: {id, email, role, path,
  expiresAt}, emailed}`. Already a member → 409. Rate-limit invite creation per inviter
  (`invite-send:user:<id>`, e.g. 30/h, 100/day) with the existing rate-limit module.

Invites:
- `GET /api/shows/:id/invites` and `GET /api/teams/:id/invites`: open invites (not accepted, not
  revoked) → `{id, email, role, invitedBy, createdAt, expiresAt, expired}`. Managers see all;
  other inviters see their own. Expired ones are listed (reissue-able) for 30 days.
- `DELETE /api/invites/:id`: revoke (inviter, show owner, team owner/admin). Mark it, don't
  delete: add `revoked_at` to invites, and `openInvite` excludes revoked.
- `POST /api/invites/:id/reissue`: same people as revoke. New token, new 7-day expiry, old link
  dead, re-sends the email → `{path, expiresAt, emailed}`. The invite id is the token hash, so
  reissue inserts a new row and revokes the old one (or adds a separate stable id column; pick
  the simpler one and say so).
- `POST /api/invites` (existing) keeps working with the new rules; also accepts `teamId` +
  `teamRole`. `GET /api/invites/:token` returns `teamName`/`teamRole` too.
- Accept joins the show or team with `invited_by` = the invite's inviter. A team invite whose
  team is gone → nothing to join (like shows).
- Transferring a show ends the old owner's open invites into it (existing). Removing someone
  from a team ends their open invites into that team. Removing a direct show member ends their
  open invites into that show.

People and account:
- `GET /api/people`: everyone who shares a show (direct) or a team with me, excluding me:
  `{id, name, email}`, sorted by name. Used for autocomplete.
- `GET /api/me/access`: `{teams: [{id, name, role, showCount}], shows: [{id, name, role,
  source, teamName?}]}`.

Email (`src/worker/email.ts`, new): `sendEmail(env, {to, subject, text, html})` → `POST
https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}`. Templates: invite
(who invited you, to what, role, the link, when it expires) and added-to (who added you, to what,
link to the show or team). Plain, short, no images. Link origin: the `APP_ORIGIN` var if set, else
the request's origin. Add `EMAIL_FROM` / `APP_ORIGIN` to `wrangler.jsonc` vars (production env),
`RESEND_API_KEY` as a documented secret (`docs/deploy.md`), regenerate types (`pnpm
cf-typegen`). Tests stub `fetch`: never call Resend from tests.

## UI (React; follow the existing components, CSS modules, and test style)

- **Shows page**: shows grouped by team (a section per team, then "Personal"); "New team"
  button; the new-show form gets a team picker (teams where I'm editor+; default Personal); each
  team header links to its team page.
- **Team page** `/teams/:id`: name (editable by owner/admin), Members (role select within your
  cap, invited by, joined, last active "3 days ago", remove, the owner's in-row "Make owner"
  confirm like `ShareSettingsMembers`), Add people (email with autocomplete from `/api/people`
  plus a role select capped to your grant level; the result says "Added" or "Invite created",
  with a Copy link button and "Emailed" / "Email not sent: copy the link"), Pending invites
  (email, role, invited by, expires / expired, Copy link only right after create/reissue since
  tokens are hashed, Reissue, Revoke with in-row confirm), Shows in this team, settings
  (invite policy, delete team: only when empty, Leave team).
- **Show settings → Members** (`ShareSettingsMembers.tsx`): the same Add people / pending
  invites / member details; team-derived rows show "via <team>" and link to the team page instead
  of offering role/remove controls; controls only render where the API would allow them (owner:
  all direct rows; editors: their invitees). A "Team" row (owner): move this show into one of
  your teams or back to Personal, with a confirm that says who gains access ("All 6 members of
  <team> will get access"). An invite policy toggle (owner).
- **My access** page `/account` (from the header's account menu): your teams (role, Leave), your
  shows (role, "direct" or "via <team>", Leave where it's a direct non-owner membership), and the
  existing password change / sign out everywhere if those currently live elsewhere (link to them,
  don't move them).
- **Invite page** shows the team name and role for team invites.
- Live: a role change or removal through a team has to flip editability / show "No access" in
  open shows exactly as direct changes do today (`notifyRole` / `revoked`).

## Phases (each: tests first, `pnpm check` green, one commit per phase on `teams-invites`)

1. **Backend core**: migration, access.ts, requireMembership / shows list / session.ts / other
   membership readers, teams routes, show team assignment, refreshAccess. Worker tests: effective
   role (direct only, team only, both, highest wins), team CRUD and rules, moving a show in/out
   (access appears/disappears; DO notified), team member removal disconnects from team shows,
   logout-all covers team shows, delete team with shows → 409.
2. **Backend invites**: invite policy, capped grants, invited_by, manage-your-invitees, people
   endpoints, team invites, pending list / revoke / reissue, people + me/access, last_active_at,
   email module. Worker tests for each rule in decision 4 (allowed and refused cases), revoke
   kills the link, reissue kills the old link, emails sent with the right content when the key
   is set and not sent without it, email failure → `emailed:false` and still 200.
3. **UI**: everything in "UI", dom tests where the repo has them for similar components, and
   e2e: (a) owner creates a team, adds an existing user as editor, creates a show in the team →
   the editor sees it; (b) an editor invites a guest by email to a show as commenter, the pending
   invite shows, the editor revokes it and the link stops working; (c) removing a team member
   live-revokes their open show tab. Follow "E2E reliability" in CLAUDE.md.
4. **Docs**: `docs/decisions/0010-teams-and-delegated-invites.md` (from the template),
   `docs/spec/requirements.md` (R23 extended for teams and delegation; "Explicitly not doing"
   keeps billing and public sign-up, drops the blanket multi-organization line or narrows it),
   `docs/spec/open-questions.md` (answers), CLAUDE.md ("Roles", "Account security → Invites",
   a new "Teams" section, the milestone line), `docs/deploy.md` (Resend secret + vars), then
   delete this plan file.

Gate before handing back: `pnpm check && pnpm e2e` in the worktree, all green. Don't merge to
main, don't push.
