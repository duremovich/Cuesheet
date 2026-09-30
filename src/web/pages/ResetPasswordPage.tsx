// /reset/<token>: an admin's one-time password reset link (R24). Setting the password
// signs out every other session of the account and signs this browser in.
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MIN_PASSWORD_LENGTH } from "../../shared/api";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import styles from "./pages.module.css";

export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getResetLink(token)
      .then((r) => setEmail(r.email))
      .catch((e: unknown) =>
        setInvalid(e instanceof Error ? e.message : "This reset link is invalid or has been used"),
      );
  }, [token]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setError("The two passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.completeReset(token, password);
      setUser(res.user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password");
      setBusy(false);
    }
  }

  return (
    <main className={styles.centered}>
      <div className={styles.authCard}>
        <h1>Set a new password</h1>
        {invalid && (
          <>
            <p className="error" role="alert">
              {invalid}
            </p>
            <Link to="/login">Go to sign in</Link>
          </>
        )}
        {!invalid && email === null && <p className="muted">Checking the link…</p>}
        {email && (
          <form className={styles.form} onSubmit={onSubmit}>
            <p style={{ margin: 0 }}>
              For <strong data-testid="reset-email">{email}</strong>. Every other signed-in device
              will be signed out.
            </p>
            <label>
              New password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </label>
            <label>
              Repeat it
              <input
                name="confirm"
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
              Set password and sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
