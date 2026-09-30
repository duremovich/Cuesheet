// "Show settings" popover: Airtable import (editors) and members (everyone sees them; the
// owner adds, changes and removes).
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  GRANTABLE_ROLES,
  type MemberDTO,
  type Role,
  type StorageResponse,
} from "../../../shared/api";
import { formatBytes } from "../../../shared/attachments";
import { IMPORT_LABEL } from "../../components/AirtableImport";
import { api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import styles from "./ShowWorkspace.module.css";
import { useWorkspace } from "./workspace";

export function ShowSettingsButton({
  members,
  onMembersChanged,
}: {
  members: MemberDTO[] | null;
  onMembersChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    panel.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className={styles.settingsWrap}>
      <button
        type="button"
        ref={button}
        className={styles.navButton}
        aria-haspopup="dialog"
        aria-label="Show settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⚙</span>{" "}
        <span className={styles.navButtonText}>Show settings</span>
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Show settings"
          className={styles.settings}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <SettingsBody
            members={members}
            onMembersChanged={onMembersChanged}
            close={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function SettingsBody({
  members,
  onMembersChanged,
  close,
}: {
  members: MemberDTO[] | null;
  onMembersChanged: () => void;
  close: () => void;
}) {
  const ws = useWorkspace();
  const handleError = useApiErrorHandler();
  const [error, setError] = useState<string | null>(null);
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
    void run(async () => {
      await api.addMember(ws.showId, { email, role });
      form.reset();
    });
  };

  return (
    <div className={styles.settingsBody}>
      {ws.canEdit && (
        <section>
          <h3>Data</h3>
          <button
            type="button"
            onClick={() => {
              close();
              ws.openImport();
            }}
          >
            {IMPORT_LABEL}
          </button>
        </section>
      )}
      <StorageUsage />
      <section>
        <h3>Members</h3>
        {members === null && <p className="muted">Loading…</p>}
        {members && (
          <ul className={styles.members} data-testid="members">
            {members.map((m) => (
              <li key={m.userId}>
                <span className={styles.memberName}>
                  {m.name} <span className="muted">{m.email}</span>
                </span>
                {isOwner && m.role !== "owner" ? (
                  <>
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
                      aria-label={`Remove ${m.name}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${m.name} from this show?`)) {
                          void run(() => api.removeMember(ws.showId, m.userId));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="muted">{m.role}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {isOwner && (
          <form className={styles.addMember} onSubmit={onAdd} aria-label="Add member">
            <input
              type="email"
              name="email"
              placeholder="Email of an existing user"
              aria-label="Email"
              required
            />
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

/** Attachment storage used by the show, of its 2 GB (R13). */
function StorageUsage() {
  const ws = useWorkspace();
  const [usage, setUsage] = useState<StorageResponse | null>(null);
  useEffect(() => {
    let live = true;
    api
      .storage(ws.showId)
      .then((u) => {
        if (live) setUsage(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws.showId]);
  return (
    <section>
      <h3>Storage</h3>
      {usage ? (
        <p data-testid="storage-usage">
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.limitBytes)} used for attachments
          <meter
            className={styles.storageMeter}
            min={0}
            max={usage.limitBytes}
            value={usage.usedBytes}
            aria-label="Attachment storage used"
          />
        </p>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </section>
  );
}
