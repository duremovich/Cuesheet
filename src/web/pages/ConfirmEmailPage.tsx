// /confirm-email/<token>: the link emailed to a new login address. Opening it is enough (no
// sign-in: it may be opened on a phone); a button confirms, so a mail scanner fetching the
// page changes nothing. Afterwards this browser's session, if any, shows the new address.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import styles from "./pages.module.css";

const BAD_LINK = "This confirmation link is invalid, expired or has been used";

export function ConfirmEmailPage() {
  const { token = "" } = useParams();
  const { user, setUser } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getEmailChange(token)
      .then((r) => setEmail(r.email))
      .catch((e: unknown) => setInvalid(e instanceof Error ? e.message : BAD_LINK));
  }, [token]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.confirmEmailChange(token);
      setDone(r.email);
      // Signed in here (as anyone): show the account as it is now.
      const me = await api.me().catch(() => null);
      if (me) setUser(me.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : BAD_LINK);
      setBusy(false);
    }
  }

  return (
    <main className={styles.centered}>
      <div className={styles.authCard}>
        <h1>Confirm your new email</h1>
        {invalid && (
          <>
            <p className="error" role="alert">
              {invalid}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              You can send a new link from your account page.
            </p>
            <Link to={user ? "/account" : "/login"}>
              {user ? "Go to your account" : "Go to sign in"}
            </Link>
          </>
        )}
        {!invalid && email === null && <p className="muted">Checking the link…</p>}
        {email && !done && (
          <div className={styles.form}>
            <p style={{ margin: 0 }}>
              Make <strong data-testid="confirm-email-address">{email}</strong> the email you sign
              in to Cuesheet with?
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              Confirm new email
            </button>
          </div>
        )}
        {done && (
          <>
            <p role="status">
              Done: you now sign in with <strong>{done}</strong>.
            </p>
            <Link to={user ? "/account" : "/login"}>{user ? "Go to your account" : "Sign in"}</Link>
          </>
        )}
      </div>
    </main>
  );
}
