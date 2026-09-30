// The header's account menu (R24): change password, sign out everywhere (every session of
// this account ends and its open shows disconnect, this browser included).
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { MIN_PASSWORD_LENGTH } from "../../shared/api";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import styles from "./AppHeader.module.css";

export function AccountMenu() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const signOutEverywhere = async () => {
    setOpen(false);
    if (!window.confirm("Sign out on every device and browser, this one included?")) return;
    await api.logoutAll().catch(() => undefined);
    setUser(null);
    navigate("/login");
  };

  return (
    <div className={styles.menuWrap}>
      <button
        type="button"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        title="Account"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Account"
          className={styles.menu}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            Change password…
          </button>
          <button type="button" role="menuitem" onClick={() => void signOutEverywhere()}>
            Sign out everywhere
          </button>
        </div>
      )}
      {changing && <ChangePassword onClose={() => setChanging(false)} />}
    </div>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = String(form.get("new") ?? "");
    if (next !== String(form.get("confirm") ?? "")) {
      setError("The new passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.changePassword({
        currentPassword: String(form.get("current") ?? ""),
        newPassword: next,
      });
      setDone(
        r.sessionsEnded > 0
          ? `Password changed. ${r.sessionsEnded} other ${r.sessionsEnded === 1 ? "session was" : "sessions were"} signed out.`
          : "Password changed.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.dialogBackdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        className={styles.dialog}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2>Change password</h2>
        {done ? (
          <>
            <p role="status">{done}</p>
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={onSubmit} className={styles.dialogForm}>
            <label>
              Current password
              <input
                ref={first}
                name="current"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              New password
              <input
                name="new"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </label>
            <label>
              Repeat the new password
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </label>
            <span className="muted">
              At least {MIN_PASSWORD_LENGTH} characters. Your other devices will be signed out.
            </span>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className={styles.dialogButtons}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Change password
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
