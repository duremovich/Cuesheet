import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CreateInviteResponse, ShowSummaryDTO, UserDTO } from "../../shared/api";
import { AppHeader } from "../components/AppHeader";
import { api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import styles from "./pages.module.css";

export function ShowsPage({ user }: { user: UserDTO }) {
  const [shows, setShows] = useState<ShowSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleError = useApiErrorHandler();

  useEffect(() => {
    api
      .listShows()
      .then((r) => setShows(r.shows))
      .catch((e: unknown) => setError(handleError(e)));
  }, [handleError]);

  return (
    <>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.card}>
          <div className={styles.sectionHeader}>
            <h2>Shows</h2>
          </div>
          <NewShowForm />
          {error && <p className="error">{error}</p>}
          {shows === null && !error && <p className="muted">Loading…</p>}
          {shows?.length === 0 && <p className="muted">No shows yet. Create one above.</p>}
          {shows && shows.length > 0 && (
            <ul className={styles.showList} data-testid="show-list" style={{ marginTop: 16 }}>
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
        {user.isAdmin && <InviteForm />}
      </main>
    </>
  );
}

function NewShowForm() {
  const handleError = useApiErrorHandler();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { show } = await api.createShow({ name });
      navigate(`/shows/${show.id}`);
    } catch (err) {
      setError(handleError(err));
      setBusy(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={onSubmit}>
      <label style={{ flex: 1 }}>
        <span>Show name</span>
        <input name="name" type="text" placeholder="Some Like It Hot" required maxLength={200} />
      </label>
      <button type="submit" className="primary" disabled={busy}>
        New show
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function InviteForm() {
  const handleError = useApiErrorHandler();
  const [invite, setInvite] = useState<CreateInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const email = String(new FormData(formEl).get("email") ?? "");
    setError(null);
    setInvite(null);
    try {
      setInvite(await api.createInvite({ email }));
      formEl.reset();
    } catch (err) {
      setError(handleError(err));
    }
  }

  const link = invite ? `${window.location.origin}${invite.path}` : "";

  return (
    <section className={styles.card}>
      <div className={styles.sectionHeader}>
        <h2>Invite a teammate</h2>
      </div>
      <form className={styles.inlineForm} onSubmit={onSubmit}>
        <label style={{ flex: 1 }}>
          <span>Email</span>
          <input name="email" type="email" required />
        </label>
        <button type="submit">Create invite link</button>
      </form>
      {error && (
        <p className="error" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      {invite && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="muted" style={{ margin: 0 }}>
            Send this one-time link to {invite.email}. It expires in 7 days.
          </p>
          <code className={styles.inviteLink} data-testid="invite-link">
            {link}
          </code>
          <div>
            <button type="button" onClick={() => navigator.clipboard?.writeText(link)}>
              Copy link
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
