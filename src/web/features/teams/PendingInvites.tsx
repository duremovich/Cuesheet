// Pending invites into a show or team (GET /shows/:id/invites, /teams/:id/invites): who,
// as what, invited by whom, when it expires (or that it did: listed 30 days more so it can
// be reissued). Everything listed is yours to revoke (managers see all, others their own;
// Revoke asks in-row first). Reissue (a new link and 7 days; the old link dies) only where
// you could still make that invite (`canReissue`): an inviter who was demoted, removed from
// the team or shut out by the invite policy can only revoke. The link itself is shown only right after the invite was made or
// reissued (`links`), since the server keeps only its hash.
import { useState } from "react";
import type { PendingInviteDTO, ReissueInviteResponse } from "../../../shared/api";
import { ConfirmStrip } from "../../components/ConfirmStrip";
import { api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import { relativeTime } from "../../lib/relativeTime";
import { CopyButton } from "./AddPeople";
import styles from "./Teams.module.css";

export function PendingInvites({
  invites,
  links,
  canReissue,
  onReissued,
  onChanged,
}: {
  invites: PendingInviteDTO[];
  /** Whether the viewer may reissue this invite (managers always; inviters while they could invite it). */
  canReissue: (invite: PendingInviteDTO) => boolean;
  /** Invite id → its one-time link path, for invites made or reissued in this page. */
  links: Readonly<Record<string, string>>;
  onReissued: (made: ReissueInviteResponse) => void;
  /** After a revoke or reissue (reload the list). */
  onChanged: () => void;
}) {
  const handleError = useApiErrorHandler();
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  /** What the last reissue did, shown on the new invite's row. */
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

  const reissue = async (invite: PendingInviteDTO) => {
    setError(null);
    try {
      const made = await api.reissueInvite(invite.id);
      onReissued(made);
      setNotice({
        id: made.id,
        text: made.emailed ? "New link emailed." : "New link made. Email not sent: copy the link.",
      });
      onChanged();
    } catch (err) {
      setError(handleError(err));
    }
  };

  const revoke = async (invite: PendingInviteDTO) => {
    setConfirmRevoke(null);
    setError(null);
    try {
      await api.revokeInvite(invite.id);
      onChanged();
    } catch (err) {
      setError(handleError(err));
    }
  };

  if (invites.length === 0 && !error) return null;
  return (
    <div className={styles.pending}>
      <h4>Pending invites</h4>
      <ul className={styles.inviteList} data-testid="pending-invites">
        {invites.map((inv) => {
          const path = links[inv.id];
          const link = path ? `${window.location.origin}${path}` : null;
          return (
            <li key={inv.id} data-expired={inv.expired ? "" : undefined}>
              <div className={styles.inviteText}>
                <strong>{inv.email}</strong> <span className="muted">{inv.role}</span>
                <span className={styles.meta}>
                  {inv.invitedBy ? `Invited by ${inv.invitedBy.name} · ` : ""}
                  {inv.expired
                    ? `Expired ${relativeTime(inv.expiresAt)}`
                    : `Expires ${relativeTime(inv.expiresAt)}`}
                </span>
              </div>
              <span className={styles.actions}>
                {canReissue(inv) && (
                  <button
                    type="button"
                    aria-label={`Reissue the invite for ${inv.email}`}
                    title="A new link, valid 7 days; the current one stops working"
                    onClick={() => void reissue(inv)}
                  >
                    Reissue
                  </button>
                )}
                <button
                  type="button"
                  data-destructive=""
                  aria-label={`Revoke the invite for ${inv.email}`}
                  aria-expanded={confirmRevoke === inv.id}
                  onClick={() => setConfirmRevoke(inv.id)}
                >
                  Revoke
                </button>
              </span>
              {link && (
                <div className={styles.freshLink}>
                  {notice?.id === inv.id && <span>{notice.text}</span>}
                  <code data-testid="pending-invite-link">{link}</code>
                  <CopyButton text={link} />
                </div>
              )}
              {confirmRevoke === inv.id && (
                <ConfirmStrip
                  text={`Revoke the invite for ${inv.email}? Its link stops working.`}
                  confirmLabel="Revoke"
                  onCancel={() => setConfirmRevoke(null)}
                  onConfirm={() => void revoke(inv)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
