// Account (/account, from the header's account menu). Profile: your name (renamed in
// place), your login email (Change… emails a link to the new address; a pending change can
// be resent or cancelled), Change password and Sign out everywhere (both also in the ⋯
// menu). Then your teams (role, how many shows, Leave unless you own it) and every show you
// can open (role, "direct" or "via <team>", Leave where you're a direct member and not the
// owner).
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ChangeEmailResponse } from "../../shared/account";
import { MAX_NAME_LENGTH, type MyAccessResponse, type UserDTO } from "../../shared/api";
import { ChangePasswordDialog, useSignOutEverywhere } from "../components/AccountMenu";
import { AppHeader } from "../components/AppHeader";
import dialogStyles from "../components/AppHeader.module.css";
import { ConfirmStrip } from "../components/ConfirmStrip";
import teamStyles from "../features/teams/Teams.module.css";
import { api } from "../lib/api";
import { useApiErrorHandler, useAuth } from "../lib/auth";
import { relativeTime } from "../lib/relativeTime";
import styles from "./pages.module.css";

type Leaving = { kind: "team" | "show"; id: string } | null;
/** What the last email-change send said (sent, or why not). */
type Notice = { text: string; ok: boolean } | null;

const sentNotice = (r: ChangeEmailResponse): NonNullable<Notice> =>
  r.emailed
    ? { text: `Confirmation sent to ${r.pending.email}.`, ok: true }
    : { text: r.message ?? "The confirmation email wasn't sent.", ok: false };

export function AccountPage({ user }: { user: UserDTO }) {
  const handleError = useApiErrorHandler();
  const { setUser } = useAuth();
  const signOutAll = useSignOutEverywhere();
  const [access, setAccess] = useState<MyAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Leaving>(null);
  const [changing, setChanging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [changingEmail, setChangingEmail] = useState(false);
  const [cancellingEmail, setCancellingEmail] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(() => {
    api
      .myAccess()
      .then(setAccess)
      .catch((e: unknown) => setError(handleError(e)));
  }, [handleError]);
  useEffect(load, [load]);

  /** Run an action; its failure becomes the page's error. */
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(handleError(e));
    }
  };

  const leave = (what: NonNullable<Leaving>) =>
    run(async () => {
      setLeaving(null);
      await (what.kind === "team" ? api.leaveTeam(what.id) : api.leaveShow(what.id));
      load();
    });

  const rename = (name: string) =>
    run(async () => {
      setUser((await api.updateProfile(name)).user);
      setRenaming(false);
    });

  const resend = () =>
    run(async () => {
      setNotice(sentNotice(await api.resendEmailChange()));
      load();
    });

  const cancelEmail = () =>
    run(async () => {
      setCancellingEmail(false);
      setNotice(null);
      await api.cancelEmailChange();
      load();
    });

  const pending = access?.pendingEmail ?? null;

  return (
    <>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="my-account">
          <Link to="/" className={teamStyles.back}>
            ← Shows
          </Link>
          <div className={styles.sectionHeader} style={{ marginTop: 8 }}>
            <h1 id="my-account" style={{ fontSize: 20 }}>
              Account
            </h1>
          </div>
          <ul className={teamStyles.list} aria-label="Profile" data-testid="profile">
            <li>
              {renaming ? (
                <NameForm
                  name={user.name}
                  onSave={(name) => void rename(name)}
                  onCancel={() => setRenaming(false)}
                />
              ) : (
                <>
                  <div className={teamStyles.rowMain}>
                    <strong data-testid="profile-name">{user.name}</strong>
                    <span className={teamStyles.meta}>Your name, as others see it</span>
                  </div>
                  <span className={teamStyles.actions}>
                    <button type="button" onClick={() => setRenaming(true)}>
                      Rename
                    </button>
                  </span>
                </>
              )}
            </li>
            <li>
              <div className={teamStyles.rowMain}>
                <span data-testid="profile-email">{user.email}</span>
                <span className={teamStyles.meta}>Your login email</span>
                {pending && (
                  <span className={teamStyles.meta} data-testid="pending-email">
                    Waiting for confirmation at <strong>{pending.email}</strong> (the link expires{" "}
                    {relativeTime(pending.expiresAt)})
                  </span>
                )}
              </div>
              <span className={teamStyles.actions}>
                {pending && (
                  <>
                    <button type="button" onClick={() => void resend()}>
                      Resend
                    </button>
                    <button
                      type="button"
                      aria-expanded={cancellingEmail}
                      onClick={() => setCancellingEmail(true)}
                    >
                      Cancel change
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setChangingEmail(true);
                  }}
                >
                  Change…
                </button>
              </span>
              {cancellingEmail && pending && (
                <ConfirmStrip
                  text={`Cancel the change to ${pending.email}? The link in that email stops working.`}
                  confirmLabel="Cancel the change"
                  onCancel={() => setCancellingEmail(false)}
                  onConfirm={() => void cancelEmail()}
                />
              )}
              {notice && (
                <p
                  className={notice.ok ? "muted" : "error"}
                  role={notice.ok ? "status" : "alert"}
                  style={{ margin: 0, flexBasis: "100%" }}
                  data-testid="email-notice"
                >
                  {notice.text}
                </p>
              )}
            </li>
          </ul>
          <div className={teamStyles.settingRow} style={{ marginTop: 12 }}>
            <button type="button" onClick={() => setChanging(true)}>
              Change password…
            </button>
            <button
              type="button"
              data-destructive=""
              aria-expanded={signingOut}
              onClick={() => setSigningOut(true)}
            >
              Sign out everywhere…
            </button>
          </div>
          {signingOut && (
            <ConfirmStrip
              text="Sign out on every device and browser, this one included?"
              confirmLabel="Sign out everywhere"
              onCancel={() => setSigningOut(false)}
              onConfirm={() => void signOutAll()}
            />
          )}
          {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
          {changingEmail && (
            <ChangeEmailDialog
              current={user.email}
              onSent={(r) => {
                setNotice(sentNotice(r));
                load();
              }}
              onClose={() => setChangingEmail(false)}
            />
          )}
          {error && (
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
        </section>

        <section className={styles.card} aria-labelledby="my-teams">
          <div className={styles.sectionHeader}>
            <h2 id="my-teams">Teams</h2>
          </div>
          {access === null && !error && <p className="muted">Loading…</p>}
          {access?.teams.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              You're not in any team.
            </p>
          )}
          {access && access.teams.length > 0 && (
            <ul className={teamStyles.list} data-testid="my-teams">
              {access.teams.map((t) => (
                <li key={t.id}>
                  <div className={teamStyles.rowMain}>
                    <Link to={`/teams/${t.id}`}>{t.name}</Link>
                    <span className={teamStyles.meta}>
                      {t.showCount} {t.showCount === 1 ? "show" : "shows"}
                    </span>
                  </div>
                  <span className={teamStyles.role}>{t.role}</span>
                  {t.role !== "owner" && (
                    <span className={teamStyles.actions}>
                      <button
                        type="button"
                        data-destructive=""
                        aria-label={`Leave ${t.name}`}
                        aria-expanded={leaving?.kind === "team" && leaving.id === t.id}
                        onClick={() => setLeaving({ kind: "team", id: t.id })}
                      >
                        Leave
                      </button>
                    </span>
                  )}
                  {leaving?.kind === "team" && leaving.id === t.id && (
                    <ConfirmStrip
                      text={`Leave ${t.name}? You lose its shows, except any you were added to directly.`}
                      confirmLabel="Leave team"
                      onCancel={() => setLeaving(null)}
                      onConfirm={() => void leave({ kind: "team", id: t.id })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.card} aria-labelledby="my-shows">
          <div className={styles.sectionHeader}>
            <h2 id="my-shows">Shows</h2>
          </div>
          {access?.shows.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              You can't open any show yet.
            </p>
          )}
          {access && access.shows.length > 0 && (
            <ul className={teamStyles.list} data-testid="my-shows">
              {access.shows.map((s) => (
                <li key={s.id}>
                  <div className={teamStyles.rowMain}>
                    <Link to={`/shows/${s.id}`}>{s.name}</Link>
                    <span className={teamStyles.meta}>
                      {s.source === "direct" ? (
                        s.teamName ? (
                          `direct · in ${s.teamName}`
                        ) : (
                          "direct"
                        )
                      ) : (
                        <>
                          via{" "}
                          {s.teamId ? (
                            <Link to={`/teams/${s.teamId}`}>{s.teamName}</Link>
                          ) : (
                            s.teamName
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  <span className={teamStyles.role}>{s.role}</span>
                  {s.source === "direct" && s.role !== "owner" && (
                    <span className={teamStyles.actions}>
                      <button
                        type="button"
                        data-destructive=""
                        aria-label={`Leave ${s.name}`}
                        aria-expanded={leaving?.kind === "show" && leaving.id === s.id}
                        onClick={() => setLeaving({ kind: "show", id: s.id })}
                      >
                        Leave
                      </button>
                    </span>
                  )}
                  {leaving?.kind === "show" && leaving.id === s.id && (
                    <ConfirmStrip
                      text={
                        s.teamName
                          ? `Leave ${s.name}? You keep any access you have through ${s.teamName}.`
                          : `Leave ${s.name}? You'll need to be added again to come back.`
                      }
                      confirmLabel="Leave show"
                      onCancel={() => setLeaving(null)}
                      onConfirm={() => void leave({ kind: "show", id: s.id })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

function NameForm({
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
      aria-label="Rename yourself"
      className={teamStyles.settingRow}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input
        name="name"
        type="text"
        aria-label="Your name"
        defaultValue={name}
        required
        maxLength={MAX_NAME_LENGTH}
        autoComplete="name"
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

/**
 * New login email + the current password → a confirmation link to the new address. The
 * login doesn't change until that link is opened.
 */
function ChangeEmailDialog({
  current,
  onSent,
  onClose,
}: {
  current: string;
  onSent: (r: ChangeEmailResponse) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChangeEmailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestEmailChange({
        newEmail: String(form.get("email") ?? ""),
        currentPassword: String(form.get("current") ?? ""),
      });
      setResult(r);
      onSent(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={dialogStyles.dialogBackdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change login email"
        className={dialogStyles.dialog}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2>Change login email</h2>
        {result ? (
          <>
            {result.emailed ? (
              <p role="status">
                We sent a link to <strong>{result.pending.email}</strong>. You sign in with{" "}
                {current} until you open it (within a day).
              </p>
            ) : (
              <p className="error" role="alert">
                {result.message}
              </p>
            )}
            <div className={dialogStyles.dialogButtons}>
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit} className={dialogStyles.dialogForm}>
            <label>
              New email
              <input ref={first} name="email" type="email" autoComplete="email" required />
            </label>
            <label>
              Current password
              <input name="current" type="password" autoComplete="current-password" required />
            </label>
            <span className="muted">
              We'll email a link to the new address; your login changes when you open it.
            </span>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className={dialogStyles.dialogButtons}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Send link
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
