# 0010: Teams, delegated invites and optional invite email

- **Status:** accepted
- **Date:** 2026-11-18

## Context

Dylan is bringing outside collaborators onto shows. Until now only a show's owner (or an
instance admin) could invite, there were no teams, invites were copy-link only, and nobody
could see or revoke a pending invite. A video team that runs several shows had to add the
same people to every show by hand, and the owner was a bottleneck for every new person.

## Decision

- **Real teams.** A team (D1 `teams`, `team_memberships`) is a set of people with a team
  role: `owner` (exactly one, the creator; transfers like a show), `admin`, `editor`,
  `commenter`, `viewer`. A show belongs to at most one team (`shows.team_id`, null =
  personal). Team members get a role on every show of the team, including shows added
  later: owner/admin → `editor`, the others the same-named show role. Team owners and
  admins never become a show's owner; a show still has exactly one owner, a direct member
  ("Co-owners: no" holds). People added straight to a show are guests (direct members).
- **Effective role = the highest** of the direct membership's role and the team-derived
  one (owner > editor > commenter > viewer). **No show-level downgrade** of a team member:
  to give someone less, change their team role or make them a guest instead. Resolution
  happens in one place (`src/worker/access.ts`, one query with left joins); the ShowDO
  keeps receiving the role from the Worker on every request and never resolves roles.
- **Delegated, capped inviting.** A show's owner always may add people; members whose
  effective role is `editor` may too unless the owner set the show's `invite_policy` to
  `owner`. In a team, the owner and admins always may; team editors too unless the team's
  policy is `owner`. Nobody grants above their own role and nobody grants `owner` (that's a
  transfer); commenters and viewers never invite. The rules are pure functions in
  `src/shared/roles.ts`, used by the Worker to enforce and by the web client to show only
  the controls the API would allow.
- **Control over your invitees.** `invited_by` is recorded on memberships, team
  memberships and invites (accepting an invite copies the invite's inviter). An inviter
  who isn't the show's owner or a team owner/admin may change the role of (within their
  cap) and remove the people they added, and revoke or reissue their own pending invites,
  for as long as they may still invite. Show owners manage every direct member; team
  owners and admins manage every team member except the owner, admins included, and
  (decided 2026-11-19) also the direct guests of their team's shows: they change a guest's
  role (up to editor, their own show role) and remove them, alongside the show's owner, and
  see and revoke every pending invite into those shows; they reissue only an invite they
  could make themselves (never under an owner-only show policy: a reissue hands the link
  to whoever asks). They never touch the show owner's
  row, so a guest added by an editor who has since left is never orphaned.
- **An invite never outlives its inviter's rights.** Accepting (and reissuing, by its
  inviter) re-checks that the inviter could still make that invite today: a demotion, a
  removal or the invite policy switched to owner makes their open invites unusable (a
  manager can reissue one, becoming its inviter). Losing access to a show or team also
  ends the invites you made into it.
- **Invites can be listed, revoked and reissued.** Revoking sets `revoked_at` (rows are
  kept). Reissuing revokes the old row and inserts a new one with a new token and 7 days
  (the id is the token's hash, so a new token is a new row); the inviter stays the
  original one. Leaving or being removed from a show or team, and handing a show over,
  end the invites that person made into it. Expired invites stay listed for 30 days so
  they can be reissued.
- **Email through Resend, optional.** With the `RESEND_API_KEY` secret set, invites and
  "you were added" notices are emailed (`src/worker/email.ts`); without it nothing is sent
  and everything works by copying the link. Sending never fails the request: the response
  says `emailed: false`. The sender is `Cuesheet <cuesheet@easyschematic.live>`
  (`EMAIL_FROM`): Resend's free plan allows one verified domain, and easyschematic.live is
  already verified on Dylan's account (EasySchematic sends from it), so no new domain or
  DNS work was needed. Replies go to the inviter (`reply_to`); each message carries
  `X-Entity-Ref-ID` (the invite id) so mail clients don't thread separate invites
  together. Non-admin inviters are limited to 30 invites an hour and 100 a day.
- **The account oracle is accepted.** Adding someone who already has an account adds them
  at once ("added"), otherwise an invite is made ("invited"), so anyone who may add people
  learns whether an email has an account. Before, only a show's owner saw that (through
  the Members list); widening it to editors is fine for a small, invite-only instance.
  `POST /api/invites` itself still answers the same for both. Public sign-up stays off.
- **Teams don't move between instances.** `scripts/migrate-show.ts` carries one show; a
  team show arrives on the target as a personal show with its direct members only (the
  target clears `team_id`). Moving whole teams isn't built.

## Consequences

- One "add people" step for a whole crew: put the shows in a team and add each person
  once. Editors can bring in their own collaborators without waiting for the owner, and
  the owner can switch that off per show.
- Every change that can move someone's access (team membership added, changed or removed,
  a show moved into or out of a team, a team transfer, a direct removal of someone who
  also has team access) must call `refreshAccess`, so open tabs get the new role or are
  closed exactly as direct changes do. A new route that changes access has to remember it.
- Members lists show team members once, with where their access comes from; team-derived
  rows are managed in the team (the show routes answer 409).
- A team with shows can't be deleted (409; move or delete its shows first).
- **ON DELETE on added columns.** drizzle-kit drops `ON DELETE` from the SQL it generates
  for `ALTER TABLE … ADD` on SQLite; migration 0006 appends the clauses by hand
  (`shows.team_id` restrict, `memberships.invited_by` set null, `invites.team_id`
  cascade), so the SQL, the schema and the snapshot agree. A team with shows can't be
  deleted, and its invites go with it. Any future column added to an existing table needs
  the same hand edit.
- Email depends on a third-party service and a verified domain owned by another project;
  if that changes, set `EMAIL_FROM` to a sender on the new domain.
