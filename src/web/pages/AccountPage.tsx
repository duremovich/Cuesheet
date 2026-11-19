// My access (/account, from the header's account menu): your teams (role, how many shows,
// Leave unless you own it) and every show you can open (role, "direct" or "via <team>",
// Leave where you're a direct member and not the owner). Password change and "Sign out
// everywhere" stay in the account menu; this page only points at them.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { MyAccessResponse, UserDTO } from "../../shared/api";
import { ChangePasswordDialog } from "../components/AccountMenu";
import { AppHeader } from "../components/AppHeader";
import { ConfirmStrip } from "../components/ConfirmStrip";
import teamStyles from "../features/teams/Teams.module.css";
import { api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import styles from "./pages.module.css";

type Leaving = { kind: "team" | "show"; id: string } | null;

export function AccountPage({ user }: { user: UserDTO }) {
  const handleError = useApiErrorHandler();
  const [access, setAccess] = useState<MyAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Leaving>(null);
  const [changing, setChanging] = useState(false);

  const load = useCallback(() => {
    api
      .myAccess()
      .then(setAccess)
      .catch((e: unknown) => setError(handleError(e)));
  }, [handleError]);
  useEffect(load, [load]);

  const leave = async (what: NonNullable<Leaving>) => {
    setLeaving(null);
    setError(null);
    try {
      await (what.kind === "team" ? api.leaveTeam(what.id) : api.leaveShow(what.id));
      load();
    } catch (e) {
      setError(handleError(e));
    }
  };

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
              My access
            </h1>
          </div>
          <p style={{ margin: 0 }}>
            <strong>{user.name}</strong> <span className="muted">{user.email}</span>
          </p>
          <div className={teamStyles.settingRow} style={{ marginTop: 12 }}>
            <button type="button" onClick={() => setChanging(true)}>
              Change password…
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              Sign out everywhere is in the ⋯ menu.
            </span>
          </div>
          {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
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
