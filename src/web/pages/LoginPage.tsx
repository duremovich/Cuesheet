import { type FormEvent, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { ThemeToggle } from "../components/ThemeToggle";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { safeNext } from "../lib/safeNext";
import styles from "./pages.module.css";

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"), window.location.origin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={next} replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.centered}>
      <div className={styles.authCard}>
        <div className={styles.sectionHeader} style={{ marginBottom: 0 }}>
          <h1>Sign in to Cuesheet</h1>
          <ThemeToggle />
        </div>
        <form className={styles.form} onSubmit={onSubmit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted" style={{ margin: 0 }}>
          Cuesheet is invite-only. Ask an admin for an invite link.
        </p>
      </div>
    </main>
  );
}
