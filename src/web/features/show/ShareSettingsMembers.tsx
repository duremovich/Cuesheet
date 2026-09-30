// Show settings → Members (R23): what each role may do, the members (the owner changes
// roles, removes people, hands the show over), leaving a show (anyone but the owner), and
// adding people: an existing account directly, or an invite link that joins this show
// with the chosen role when accepted.
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import {
  type CreateInviteResponse,
  GRANTABLE_ROLES,
  type MemberDTO,
  type Role,
} from "../../../shared/api";
import { EyeIcon } from "../../components/PresenceIndicator";
import { ApiError, api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import styles from "./ShareSettings.module.css";
import wsStyles from "./ShowWorkspace.module.css";
import { useWorkspace } from "./workspace";

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Everything, plus members, sharing and backups. One per show.",
  editor: "Edits everything: cues, content, views, imports.",
  commenter: "Reads everything; adds notes and edits their own. Can be @mentioned.",
  viewer: "Reads everything (shown with an eye in presence); only their own views.",
};

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
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ email: string; role: Role } | null>(null);
  const [inviteLink, setInviteLink] = useState<CreateInviteResponse | null>(null);
  const isOwner = ws.role === "owner";

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onMembersChanged();
    } catch (e) {
      setError(handleError(e));
    }
  };

  const onAdd = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const role = String(data.get("role") ?? "editor") as Role;
    if (!email) return;
    setInvite(null);
    setInviteLink(null);
    setError(null);
    api
      .addMember(ws.showId, { email, role })
      .then(() => {
        form.reset();
        onMembersChanged();
      })
      .catch((err: unknown) => {
        // No account yet: offer an invite that joins this show.
        if (err instanceof ApiError && err.status === 404) setInvite({ email, role });
        else setError(handleError(err));
      });
  };

  const makeInvite = async () => {
    if (!invite) return;
    setError(null);
    try {
      setInviteLink(
        await api.createInvite({ email: invite.email, role: invite.role, showId: ws.showId }),
      );
      setInvite(null);
    } catch (err) {
      setError(handleError(err));
    }
  };

  const leave = async () => {
    if (!window.confirm(`Leave ${ws.showName}? You'll need to be added again to come back.`)) {
      return;
    }
    try {
      await api.leaveShow(ws.showId);
      navigate("/");
    } catch (err) {
      setError(handleError(err));
    }
  };

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
      {members === null && <p className="muted">Loading…</p>}
      {members && (
        <ul className={wsStyles.members} data-testid="members">
          {members.map((m) => (
            <li key={m.userId}>
              <span className={wsStyles.memberName}>
                {m.name} <span className="muted">{m.email}</span>
              </span>
              {isOwner && m.role !== "owner" ? (
                <span className={styles.memberActions}>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(e) =>
                      void run(() =>
                        api.updateMember(ws.showId, m.userId, { role: e.target.value as Role }),
                      )
                    }
                  >
                    {GRANTABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Make ${m.name} the owner`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Make ${m.name} the owner of ${ws.showName}? You'll become an editor and can't undo this yourself.`,
                        )
                      ) {
                        void run(() => api.transferOwnership(ws.showId, m.userId));
                      }
                    }}
                  >
                    Make owner
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => {
                      if (window.confirm(`Remove ${m.name} from this show?`)) {
                        void run(() => api.removeMember(ws.showId, m.userId));
                      }
                    }}
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
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <form className={wsStyles.addMember} onSubmit={onAdd} aria-label="Add member">
          <input type="email" name="email" placeholder="Email" aria-label="Email" required />
          <select name="role" aria-label="Role" defaultValue="editor">
            {GRANTABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit">Add</button>
        </form>
      )}
      {invite && (
        <div className={styles.invite} data-testid="invite-offer">
          <span>
            {invite.email} has no account yet. Invite them? They'll join this show as {invite.role}.
          </span>
          <button type="button" onClick={() => void makeInvite()}>
            Create invite link
          </button>
        </div>
      )}
      {inviteLink && (
        <div className={styles.invite} data-testid="show-invite-link">
          <span>Send this one-time link to {inviteLink.email} (valid 7 days):</span>
          <code>{`${window.location.origin}${inviteLink.path}`}</code>
        </div>
      )}
      {!isOwner && (
        <button type="button" onClick={() => void leave()} data-destructive="">
          Leave this show
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
