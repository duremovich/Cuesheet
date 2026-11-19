// A team (/teams/:id): its name (owner and admins rename it), members (role, who added
// them, joined, last active; the controls access.ts would allow: owner and admins manage
// everyone but the owner, other inviters the people they added; the owner's "Make owner"),
// adding people and the pending invites, the team's shows, and settings (who may add
// people, delete an empty team, leave). Confirmations are in-row, never native dialogs.
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  GRANTABLE_TEAM_ROLES,
  type InvitePolicy,
  type PendingInviteDTO,
  type ShowSummaryDTO,
  TEAM_ROLES,
  type TeamDTO,
  type TeamMemberDTO,
  type TeamRole,
  type UserDTO,
} from "../../shared/api";
import { canGrant, canInviteToTeam, canManageTeamMember, isTeamManager } from "../../shared/roles";
import { AppHeader } from "../components/AppHeader";
import { ConfirmStrip } from "../components/ConfirmStrip";
import { AddPeople } from "../features/teams/AddPeople";
import { MemberMeta } from "../features/teams/MemberMeta";
import { PendingInvites } from "../features/teams/PendingInvites";
import { TEAM_ROLE_DESCRIPTIONS, withArticle } from "../features/teams/roleText";
import teamStyles from "../features/teams/Teams.module.css";
import { ApiError, api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import styles from "./pages.module.css";

/** Which in-row confirmation is open: a member's (by id) or a team-level one. */
type Confirm =
  | { kind: "owner" | "remove"; userId: string }
  | { kind: "delete" }
  | { kind: "leave" }
  | null;

export function TeamPage({ user }: { user: UserDTO }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const handleError = useApiErrorHandler();
  const [team, setTeam] = useState<TeamDTO | null>(null);
  const [members, setMembers] = useState<TeamMemberDTO[] | null>(null);
  const [shows, setShows] = useState<ShowSummaryDTO[] | null>(null);
  const [invites, setInvites] = useState<PendingInviteDTO[]>([]);
  /** One-time links of invites made or reissued on this page (invite id → path). */
  const [links, setLinks] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getTeam(id), api.teamMembers(id), api.teamShows(id), api.teamInvites(id)])
      .then(([t, m, s, i]) => {
        setTeam(t.team);
        setMembers(m.members);
        setShows(s.shows);
        setInvites(i.invites);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(handleError(e));
      });
  }, [id, handleError]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, after: () => void = load) => {
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError(handleError(e));
    }
  };

  const memberEmails = useMemo(() => new Set((members ?? []).map((m) => m.email)), [members]);

  if (notFound) {
    return (
      <>
        <AppHeader />
        <main className={styles.main}>
          <section className={styles.card}>
            <p>This team doesn't exist, or you're not in it.</p>
            <Link to="/">Back to shows</Link>
          </section>
        </main>
      </>
    );
  }

  const myRole = team?.role ?? null;
  const manager = isTeamManager(myRole);
  const grantable = myRole ? GRANTABLE_TEAM_ROLES.filter((r) => canGrant(myRole, r)) : [];

  return (
    <>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.card}>
          <Link to="/" className={teamStyles.back}>
            ← Shows
          </Link>
          {team === null && !error && <p className="muted">Loading…</p>}
          {team && (
            <div className={teamStyles.titleRow} style={{ marginTop: 8 }}>
              {renaming ? (
                <RenameForm
                  name={team.name}
                  onCancel={() => setRenaming(false)}
                  onSave={(name) =>
                    void run(
                      () => api.updateTeam(team.id, { name }),
                      () => {
                        setRenaming(false);
                        load();
                      },
                    )
                  }
                />
              ) : (
                <>
                  <h1 data-testid="team-name">{team.name}</h1>
                  {manager && (
                    <button type="button" onClick={() => setRenaming(true)}>
                      Rename
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {team && (
            <p className="muted" style={{ margin: "8px 0 0" }} data-testid="my-team-role">
              You're {team.role === "owner" ? "the owner" : withArticle(team.role)} of this team.
            </p>
          )}
          {error && (
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
        </section>

        {team && members && (
          <section className={styles.card} aria-labelledby="team-members">
            <div className={styles.sectionHeader}>
              <h2 id="team-members">Members</h2>
            </div>
            <dl className={teamStyles.roles} data-testid="team-role-descriptions">
              {TEAM_ROLES.map((r) => (
                <div key={r} style={{ display: "contents" }}>
                  <dt>{r}</dt>
                  <dd>{TEAM_ROLE_DESCRIPTIONS[r]}</dd>
                </div>
              ))}
            </dl>
            <ul className={teamStyles.list} data-testid="team-members">
              {members.map((m) => {
                const me = m.userId === user.id;
                const manages =
                  !me &&
                  canManageTeamMember({ id: user.id, role: team.role }, team.invitePolicy, {
                    role: m.role,
                    invitedBy: m.invitedBy?.id ?? null,
                  });
                return (
                  <li key={m.userId}>
                    <div className={teamStyles.rowMain}>
                      <strong>{m.name}</strong> <span className="muted">{m.email}</span>
                      {me && <span className="muted"> (you)</span>}
                      <MemberMeta
                        invitedBy={m.invitedBy}
                        joinedAt={m.joinedAt}
                        lastActiveAt={m.lastActiveAt}
                      />
                    </div>
                    {manages ? (
                      <span className={teamStyles.actions}>
                        <select
                          aria-label={`Role for ${m.name}`}
                          value={m.role}
                          onChange={(e) =>
                            void run(() =>
                              api.updateTeamMember(team.id, m.userId, e.target.value as TeamRole),
                            )
                          }
                        >
                          {grantable.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        {team.role === "owner" && (
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
                      <span className={teamStyles.role} data-testid="member-role">
                        {m.role}
                      </span>
                    )}
                    {confirm?.kind === "owner" && confirm.userId === m.userId && (
                      <ConfirmStrip
                        text={`Make ${m.name} the owner of ${team.name}? You'll become an admin and can't undo this yourself.`}
                        confirmLabel="Make owner"
                        onCancel={() => setConfirm(null)}
                        onConfirm={() => {
                          setConfirm(null);
                          void run(() => api.transferTeam(team.id, m.userId));
                        }}
                      />
                    )}
                    {confirm?.kind === "remove" && confirm.userId === m.userId && (
                      <ConfirmStrip
                        text={`Remove ${m.name} from ${team.name}? They lose the team's shows, except any they were added to directly.`}
                        confirmLabel="Remove"
                        onCancel={() => setConfirm(null)}
                        onConfirm={() => {
                          setConfirm(null);
                          void run(() => api.removeTeamMember(team.id, m.userId));
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {canInviteToTeam(team.role, team.invitePolicy) && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ fontSize: 14, marginBottom: 4 }}>Add people</h3>
                <AddPeople
                  roles={grantable}
                  add={(email, role) => api.addTeamPeople(team.id, { email, role })}
                  targetPath={`/teams/${team.id}`}
                  exclude={memberEmails}
                  onDone={load}
                  onInvited={(inviteId, path) => setLinks((l) => ({ ...l, [inviteId]: path }))}
                />
              </div>
            )}
            <PendingInvites
              invites={invites}
              canReissue={(inv) =>
                manager ||
                (canInviteToTeam(team.role, team.invitePolicy) && canGrant(team.role, inv.role))
              }
              links={links}
              onReissued={(made) => setLinks((l) => ({ ...l, [made.id]: made.path }))}
              onChanged={load}
            />
          </section>
        )}

        {team && shows && (
          <section className={styles.card} aria-labelledby="team-shows">
            <div className={styles.sectionHeader}>
              <h2 id="team-shows">Shows in this team</h2>
            </div>
            {shows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No shows in this team yet. Create one from the <Link to="/">show list</Link> and
                pick this team.
              </p>
            ) : (
              <ul className={styles.showList} data-testid="team-shows">
                {shows.map((s) => (
                  <li key={s.id}>
                    <Link to={`/shows/${s.id}`}>
                      <span className={styles.showListName} title={s.name}>
                        {s.name}
                      </span>
                      <span className={`muted ${styles.showListRole}`}>{s.role}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {team && shows && (
          <section className={styles.card} aria-labelledby="team-settings">
            <div className={styles.sectionHeader}>
              <h2 id="team-settings">Settings</h2>
            </div>
            {manager && (
              <div className={`${teamStyles.settingRow} ${teamStyles.cardSection}`}>
                <label>
                  Who can add people
                  <select
                    value={team.invitePolicy}
                    onChange={(e) =>
                      void run(() =>
                        api.updateTeam(team.id, { invitePolicy: e.target.value as InvitePolicy }),
                      )
                    }
                  >
                    <option value="editors">Owner, admins and editors</option>
                    <option value="owner">Only the owner and admins</option>
                  </select>
                </label>
              </div>
            )}
            {team.role === "owner" && shows.length > 0 && (
              <p className={`muted ${teamStyles.cardSection}`} style={{ margin: 0 }}>
                To delete the team, move its shows out (or delete them) first.
              </p>
            )}
            {team.role === "owner" && shows.length === 0 && (
              <div className={`${teamStyles.settingRow} ${teamStyles.cardSection}`}>
                <button
                  type="button"
                  data-destructive=""
                  aria-expanded={confirm?.kind === "delete"}
                  onClick={() => setConfirm({ kind: "delete" })}
                >
                  Delete team
                </button>
                {confirm?.kind === "delete" && (
                  <ConfirmStrip
                    text={`Delete ${team.name}? Its members and pending invites go with it.`}
                    confirmLabel="Delete team"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                      setConfirm(null);
                      void run(
                        () => api.deleteTeam(team.id),
                        () => navigate("/"),
                      );
                    }}
                  />
                )}
              </div>
            )}
            {team.role !== "owner" && (
              <div className={`${teamStyles.settingRow} ${teamStyles.cardSection}`}>
                <button
                  type="button"
                  data-destructive=""
                  aria-expanded={confirm?.kind === "leave"}
                  onClick={() => setConfirm({ kind: "leave" })}
                >
                  Leave team
                </button>
                {confirm?.kind === "leave" && (
                  <ConfirmStrip
                    text={`Leave ${team.name}? You lose its shows, except any you were added to directly.`}
                    confirmLabel="Leave team"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                      setConfirm(null);
                      void run(
                        () => api.leaveTeam(team.id),
                        () => navigate("/"),
                      );
                    }}
                  />
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </>
  );
}

function RenameForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (next) onSave(next);
  };
  return (
    <form
      onSubmit={onSubmit}
      aria-label="Rename team"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input
        name="name"
        type="text"
        aria-label="Team name"
        defaultValue={name}
        required
        maxLength={200}
        // biome-ignore lint/a11y/noAutofocus: the field the user just asked for
        autoFocus
      />
      <button type="submit" className="primary">
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
