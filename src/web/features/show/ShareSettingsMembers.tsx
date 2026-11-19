// Show settings → Members (R23): what each role may do, the show's team (the owner moves
// it into one of their teams or back to Personal; the team's owner/admins may make it
// personal), the members with their details (invited by, joined, last active), adding
// people and the pending invites, who may add people (owner), and leaving the show.
//
// Controls follow the API's rules (src/shared/roles.ts): the owner and the owner/admins of
// the show's team manage every direct member and revoke any pending invite (only the
// owner, or the invite's sender while they could still send it, reissues), an editor
// allowed to invite manages the people they added; nobody grants above their own show role. People who are here through the show's team ("via <team>") are managed
// in the team. Every confirmation is in-row (ConfirmStrip), never a native dialog.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  GRANTABLE_ROLES,
  type InvitePolicy,
  type MemberDTO,
  type PendingInviteDTO,
  type Role,
  type ShowInfoDTO,
  type TeamDTO,
} from "../../../shared/api";
import {
  canGrant,
  canInviteToShow,
  canManageShowMember,
  isTeamEditor,
  isTeamManager,
} from "../../../shared/roles";
import { ConfirmStrip } from "../../components/ConfirmStrip";
import { EyeIcon } from "../../components/PresenceIndicator";
import { api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import { AddPeople } from "../teams/AddPeople";
import { MemberMeta } from "../teams/MemberMeta";
import { PendingInvites } from "../teams/PendingInvites";
import styles from "./ShareSettings.module.css";
import wsStyles from "./ShowWorkspace.module.css";
import { useWorkspace } from "./workspace";

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Everything, plus members, sharing and backups. One per show.",
  editor: "Edits everything: cues, content, views, imports.",
  commenter: "Reads everything; adds notes and edits their own. Can be @mentioned.",
  viewer: "Reads everything (shown with an eye in presence); only their own views.",
};

type ShowTeamInfo = Pick<ShowInfoDTO, "teamId" | "teamName" | "invitePolicy">;

type Confirm = { kind: "owner" | "remove"; userId: string } | { kind: "leave" } | null;

/** The show's team and invite policy, read fresh (another member may have changed them). */
function useShowTeamInfo(showId: string): [ShowTeamInfo | null, () => void] {
  const [info, setInfo] = useState<ShowTeamInfo | null>(null);
  const load = useCallback(() => {
    api
      .getShow(showId)
      .then(({ show }) =>
        setInfo({ teamId: show.teamId, teamName: show.teamName, invitePolicy: show.invitePolicy }),
      )
      .catch(() => undefined);
  }, [showId]);
  useEffect(load, [load]);
  return [info, load];
}

export function MembersSection({
  members,
  onMembersChanged,
}: {
  members: MemberDTO[] | null;
  onMembersChanged: () => void;
}) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const handleError = useApiErrorHandler();
  const [info, reloadInfo] = useShowTeamInfo(ws.showId);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<PendingInviteDTO[]>([]);
  /** One-time links of invites made or reissued here (invite id → path). */
  const [links, setLinks] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm>(null);
  const isOwner = ws.role === "owner";

  // Pending invites: the owner's list has everyone's, anyone else's their own (also after
  // they were demoted or the policy changed, so they can still revoke them).
  const loadInvites = useCallback(() => {
    api
      .showInvites(ws.showId)
      .then((r) => setInvites(r.invites))
      .catch(() => undefined);
  }, [ws.showId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a role change (live) can add or drop invites to show
  useEffect(loadInvites, [loadInvites, ws.role]);

  const refresh = () => {
    onMembersChanged();
    loadInvites();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(handleError(e));
    }
  };

  const leave = async () => {
    setConfirm(null);
    try {
      await api.leaveShow(ws.showId);
      navigate("/");
    } catch (err) {
      setError(handleError(err));
    }
  };

  const mine = members?.find((m) => m.userId === ws.userId);
  // The team page only opens for the team's members.
  const inTeam = !!mine?.teamRole;
  const policy = info?.invitePolicy ?? "editors";
  const grantable = GRANTABLE_ROLES.filter((r) => canGrant(ws.role, r));
  const memberEmails = useMemo(() => new Set((members ?? []).map((m) => m.email)), [members]);
  const teamName = info?.teamName ?? "the team";
  const teamLink =
    info?.teamId && inTeam ? <Link to={`/teams/${info.teamId}`}>{teamName}</Link> : teamName;

  return (
    <section>
      <h3>Members</h3>
      <dl className={styles.roles} data-testid="role-descriptions">
        {(["owner", ...GRANTABLE_ROLES] as Role[]).map((r) => (
          <div key={r} style={{ display: "contents" }}>
            <dt>{r}</dt>
            <dd>{ROLE_DESCRIPTIONS[r]}</dd>
          </div>
        ))}
      </dl>
      {info && (
        <ShowTeam
          info={info}
          isOwner={isOwner}
          teamManager={isTeamManager(mine?.teamRole)}
          teamLink={teamLink}
          onMoved={() => {
            reloadInfo();
            refresh();
          }}
          onError={(e) => setError(handleError(e))}
        />
      )}
      {members === null && <p className="muted">Loading…</p>}
      {members && (
        <ul className={wsStyles.members} data-testid="members">
          {members.map((m) => {
            const me = m.userId === ws.userId;
            const manages =
              !me &&
              m.source === "direct" &&
              !!m.directRole &&
              !!info &&
              canManageShowMember(
                { id: ws.userId, role: ws.role, teamRole: mine?.teamRole },
                policy,
                {
                  role: m.directRole,
                  invitedBy: m.invitedBy?.id ?? null,
                },
              );
            return (
              <li key={m.userId} data-source={m.source}>
                <span className={wsStyles.memberName}>
                  {m.name} <span className="muted">{m.email}</span>
                  <MemberMeta
                    invitedBy={m.invitedBy}
                    joinedAt={m.joinedAt}
                    lastActiveAt={m.lastActiveAt}
                  >
                    {m.source === "team" && <>via {teamLink}</>}
                    {m.source === "direct" && m.teamRole && (
                      <>
                        also {m.teamRole} in {teamLink}
                      </>
                    )}
                  </MemberMeta>
                </span>
                {manages ? (
                  <span className={styles.memberActions}>
                    <select
                      aria-label={`Role for ${m.name}`}
                      value={m.directRole ?? m.role}
                      onChange={(e) =>
                        void run(() =>
                          api.updateMember(ws.showId, m.userId, { role: e.target.value as Role }),
                        )
                      }
                    >
                      {grantable.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {isOwner && (
                      <button
                        type="button"
                        aria-label={`Make ${m.name} the owner`}
                        aria-expanded={confirm?.kind === "owner" && confirm.userId === m.userId}
                        onClick={() => setConfirm({ kind: "owner", userId: m.userId })}
                      >
                        Make owner
                      </button>
                    )}
                    <button
                      type="button"
                      data-destructive=""
                      aria-label={`Remove ${m.name}`}
                      aria-expanded={confirm?.kind === "remove" && confirm.userId === m.userId}
                      onClick={() => setConfirm({ kind: "remove", userId: m.userId })}
                    >
                      Remove
                    </button>
                  </span>
                ) : (
                  <span className={styles.roleLabel} data-testid="member-role">
                    {m.role === "viewer" && <EyeIcon />}
                    {m.role}
                  </span>
                )}
                {confirm?.kind === "owner" && confirm.userId === m.userId && (
                  <ConfirmStrip
                    text={`Make ${m.name} the owner of ${ws.showName}? You'll become an editor and can't undo this yourself.`}
                    confirmLabel="Make owner"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                      setConfirm(null);
                      void run(() => api.transferOwnership(ws.showId, m.userId));
                    }}
                  />
                )}
                {confirm?.kind === "remove" && confirm.userId === m.userId && (
                  <ConfirmStrip
                    text={
                      m.teamRole
                        ? `Remove ${m.name} from ${ws.showName}? They keep their access through the team.`
                        : `Remove ${m.name} from ${ws.showName}? Their open tabs lose access at once.`
                    }
                    confirmLabel="Remove"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                      setConfirm(null);
                      void run(() => api.removeMember(ws.showId, m.userId));
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {info && canInviteToShow(ws.role, info.invitePolicy) && (
        <AddPeople
          roles={grantable}
          add={(email, role) => api.addShowPeople(ws.showId, { email, role })}
          targetPath={`/shows/${ws.showId}`}
          exclude={memberEmails}
          onDone={refresh}
          onInvited={(inviteId, path) => setLinks((l) => ({ ...l, [inviteId]: path }))}
        />
      )}
      <PendingInvites
        invites={invites}
        // Anyone who sees an invite may revoke it (the owner and the team's owner/admins see
        // them all). Reissue: the owner, or the sender while they could still send it; a
        // team admin can't mint links past an owner-only policy.
        canReissue={(inv) =>
          isOwner ||
          (inv.invitedBy?.id === ws.userId &&
            canInviteToShow(ws.role, policy) &&
            canGrant(ws.role, inv.role))
        }
        links={links}
        onReissued={(made) => setLinks((l) => ({ ...l, [made.id]: made.path }))}
        onChanged={loadInvites}
      />
      {info && isOwner && (
        <label className={styles.policy}>
          Who can add people
          <select
            value={info.invitePolicy}
            onChange={(e) =>
              void run(async () => {
                await api.updateShow(ws.showId, { invitePolicy: e.target.value as InvitePolicy });
                reloadInfo();
              })
            }
          >
            <option value="editors">Owner and editors</option>
            <option value="owner">Only the owner</option>
          </select>
        </label>
      )}
      {mine?.source === "direct" && !isOwner && (
        <div className={styles.leaveRow}>
          <button
            type="button"
            data-destructive=""
            aria-expanded={confirm?.kind === "leave"}
            onClick={() => setConfirm({ kind: "leave" })}
          >
            Leave this show
          </button>
          {confirm?.kind === "leave" && (
            <ConfirmStrip
              text={
                mine.teamRole
                  ? `Leave ${ws.showName}? You keep your access through the team.`
                  : `Leave ${ws.showName}? You'll need to be added again to come back.`
              }
              confirmLabel="Leave"
              onCancel={() => setConfirm(null)}
              onConfirm={() => void leave()}
            />
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The show's team. The owner picks one of their teams (where they're an editor or up) or
 * Personal; the team's owner/admins may make it personal. A move asks first, saying who
 * gains or loses access.
 */
function ShowTeam({
  info,
  isOwner,
  teamManager,
  teamLink,
  onMoved,
  onError,
}: {
  info: ShowTeamInfo;
  isOwner: boolean;
  teamManager: boolean;
  teamLink: ReactNode;
  onMoved: () => void;
  onError: (e: unknown) => void;
}) {
  const ws = useWorkspace();
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  /** The move waiting for its confirmation; `count`: how many people the target team has. */
  const [pending, setPending] = useState<{ teamId: string | null; count: number | null } | null>(
    null,
  );

  useEffect(() => {
    if (!isOwner) return;
    api
      .listTeams()
      .then((r) => setTeams(r.teams.filter((t) => isTeamEditor(t.role))))
      .catch(() => undefined);
  }, [isOwner]);

  const choose = (teamId: string | null) => {
    if (teamId === info.teamId) {
      setPending(null);
      return;
    }
    setPending({ teamId, count: null });
    if (!teamId) return;
    api
      .teamMembers(teamId)
      .then((r) =>
        setPending((p) => (p?.teamId === teamId ? { teamId, count: r.members.length } : p)),
      )
      .catch(() => undefined);
  };

  const move = async (teamId: string | null) => {
    setPending(null);
    try {
      await api.updateShow(ws.showId, { teamId });
      onMoved();
    } catch (e) {
      onError(e);
    }
  };

  const confirmText = () => {
    if (!pending) return "";
    const parts: string[] = [];
    if (pending.teamId) {
      const name = teams.find((t) => t.id === pending.teamId)?.name ?? "the team";
      const n = pending.count;
      const who =
        n === null ? `The members of ${name}` : n === 1 ? "Its 1 member" : `All ${n} members`;
      parts.push(`Move ${ws.showName} into ${name}? ${who} will get access.`);
    } else {
      parts.push(`Make ${ws.showName} personal?`);
    }
    if (info.teamId) {
      parts.push(
        `Members of ${info.teamName} lose access unless they were added to this show directly.`,
      );
    }
    return parts.join(" ");
  };

  const showSelect = isOwner && (teams.length > 0 || info.teamId !== null);
  return (
    <div className={styles.teamRow} data-testid="show-team">
      {showSelect ? (
        <label>
          Team
          <select
            value={pending ? (pending.teamId ?? "") : (info.teamId ?? "")}
            onChange={(e) => choose(e.target.value || null)}
          >
            <option value="">Personal</option>
            {info.teamId && !teams.some((t) => t.id === info.teamId) && (
              <option value={info.teamId}>{info.teamName}</option>
            )}
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span>Team: {info.teamId ? teamLink : "Personal"}</span>
      )}
      {!isOwner && teamManager && info.teamId && (
        <button type="button" aria-expanded={!!pending} onClick={() => choose(null)}>
          Make personal
        </button>
      )}
      {pending && (
        <ConfirmStrip
          text={confirmText()}
          confirmLabel={pending.teamId ? "Move" : "Make personal"}
          onCancel={() => setPending(null)}
          onConfirm={() => void move(pending.teamId)}
        />
      )}
    </div>
  );
}
