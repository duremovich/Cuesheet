import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { type InviteInfoResponse, MIN_PASSWORD_LENGTH } from "../../shared/api";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import styles from "./pages.module.css";

export function InvitePage() {
  const { token = "" } = useParams();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteInfoResponse | null>(null);
  const email = invite?.email ?? null;
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getInvite(token)
      .then(setInvite)
      .catch(() => setInvalid(true));
  }, [token]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api.acceptInvite(token, {
        name: String(form.get("name") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      setUser(res.user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invite");
      setBusy(false);
    }
  }

  return (
    <main className={styles.centered}>
      <div className={styles.authCard}>
        <h1>Join Cuesheet</h1>
        {invalid && (
          <>
            <p className="error" role="alert">
              This invite link is invalid or has already been used.
            </p>
            <Link to="/login">Go to sign in</Link>
          </>
        )}
        {!invalid && email === null && <p className="muted">Checking invite…</p>}
        {email && (
          <form className={styles.form} onSubmit={onSubmit}>
            <p style={{ margin: 0 }}>
              Setting up the account for <strong data-testid="invite-email">{email}</strong>.
              {invite?.showName && (
                <>
                  {" "}
                  You'll join <strong data-testid="invite-show">{invite.showName}</strong> as{" "}
                  {invite.role === "editor" ? "an editor" : `a ${invite.role ?? "member"}`}.
                </>
              )}
            </p>
            <label>
              Your name
              <input name="name" type="text" autoComplete="name" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </label>
            <span className="muted">At least {MIN_PASSWORD_LENGTH} characters.</span>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={busy}>
              Create account
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
