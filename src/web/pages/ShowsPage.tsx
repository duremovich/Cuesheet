import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CreateResetLinkResponse } from "../../shared/account";
import {
  type CreateInviteResponse,
  GRANTABLE_ROLES,
  type Role,
  type ShowSummaryDTO,
  type TeamDTO,
  type UserDTO,
} from "../../shared/api";
import { isTeamEditor } from "../../shared/roles";
import { AppHeader } from "../components/AppHeader";
import { api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import styles from "./pages.module.css";

/** The shows of one team, or (`team` null) the personal ones. */
interface ShowGroup {
  key: string;
  /** `role` null: a team you're not in (you were added to some of its shows). */
  team: { id: string; name: string; role: TeamDTO["role"] | null } | null;
  shows: ShowSummaryDTO[];
}

/**
 * A group per team you're in (even without shows), then one per other team whose shows
 * you were added to as a guest (there's no team page for you there), then your personal
 * shows.
 */
function groupShows(shows: ShowSummaryDTO[], teams: TeamDTO[]): ShowGroup[] {
  const groups = new Map<string, ShowGroup>();
  for (const t of teams) {
    groups.set(t.id, { key: t.id, team: { id: t.id, name: t.name, role: t.role }, shows: [] });
  }
  const personal: ShowGroup = { key: "personal", team: null, shows: [] };
  for (const s of shows) {
    if (!s.teamId) {
      personal.shows.push(s);
      continue;
    }
    let g = groups.get(s.teamId);
    if (!g) {
      g = { key: s.teamId, team: { id: s.teamId, name: s.teamName ?? "", role: null }, shows: [] };
      groups.set(s.teamId, g);
    }
    g.shows.push(s);
  }
  return [...groups.values(), personal];
}

export function ShowsPage({ user }: { user: UserDTO }) {
  const [shows, setShows] = useState<ShowSummaryDTO[] | null>(null);
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(false);
  const handleError = useApiErrorHandler();

  useEffect(() => {
    Promise.all([api.listShows(), api.listTeams()])
      .then(([s, t]) => {
        setShows(s.shows);
        setTeams(t.teams);
      })
      .catch((e: unknown) => setError(handleError(e)));
  }, [handleError]);

  const regular = (shows ?? []).filter((s) => !s.isTemplate);
  const groups = groupShows(regular, teams);
  // Without teams the list looks as it always did: one list, no "Personal" heading.
  const grouped = groups.length > 1;

  return (
    <>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.card}>
          <div className={styles.sectionHeader}>
            <h2>Shows</h2>
            <button type="button" aria-expanded={newTeam} onClick={() => setNewTeam((o) => !o)}>
              New team
            </button>
          </div>
          {newTeam && <NewTeamForm onCancel={() => setNewTeam(false)} />}
          <NewShowForm teams={teams.filter((t) => isTeamEditor(t.role))} />
          {error && <p className="error">{error}</p>}
          {shows === null && !error && <p className="muted">Loading…</p>}
          {shows && regular.length === 0 && (
            <p className="muted">No shows yet. Create one above.</p>
          )}
          {shows && (regular.length > 0 || grouped) && (
            <div className={styles.showGroups} data-testid="show-list" style={{ marginTop: 16 }}>
              {groups
                .filter((g) => g.shows.length > 0 || (g.team && grouped))
                .map((g) => (
                  <section key={g.key} aria-label={g.team ? g.team.name : "Personal"}>
                    {grouped && <GroupHeader group={g} />}
                    {g.shows.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        No shows in this team yet.
                      </p>
                    ) : (
                      <ul className={styles.showList}>
                        {g.shows.map((s) => (
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
                ))}
            </div>
          )}
        </section>
        {shows?.some((s) => s.isTemplate) && (
          <TemplatesSection templates={shows.filter((s) => s.isTemplate)} />
        )}
        {user.isAdmin && <InviteForm shows={regular} />}
        {user.isAdmin && <ResetLinkForm />}
      </main>
    </>
  );
}

/** A team's name (linking to its page when you're in it) and your role there. */
function GroupHeader({ group }: { group: ShowGroup }) {
  const { team } = group;
  return (
    <div className={styles.groupHeader}>
      <h3>
        {team?.role ? (
          <Link to={`/teams/${team.id}`}>{team.name}</Link>
        ) : (
          (team?.name ?? "Personal")
        )}
      </h3>
      {team && <span className="muted">{team.role ? `team ${team.role}` : "guest"}</span>}
    </div>
  );
}

/** A new team (you're its owner); opens its page. */
function NewTeamForm({ onCancel }: { onCancel: () => void }) {
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
      const { team } = await api.createTeam(name);
      navigate(`/teams/${team.id}`);
    } catch (err) {
      setError(handleError(err));
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.inlineForm}
      onSubmit={onSubmit}
      aria-label="New team"
      style={{ marginBottom: 16 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <label style={{ flex: 1 }}>
        <span>Team name</span>
        <input
          name="name"
          type="text"
          required
          maxLength={200}
          // biome-ignore lint/a11y/noAutofocus: the form appears on request
          autoFocus
        />
      </label>
      <button type="submit" className="primary" disabled={busy}>
        Create team
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Templates (R27): listed apart from shows; "New from template" copies one's structure. */
function TemplatesSection({ templates }: { templates: ShowSummaryDTO[] }) {
  const handleError = useApiErrorHandler();
  const navigate = useNavigate();
  const usable = templates.filter((t) => t.role === "owner" || t.role === "editor");
  const [templateId, setTemplateId] = useState(usable[0]?.id ?? "");
  const [includeScenes, setIncludeScenes] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name || !templateId) return;
    setBusy(true);
    setError(null);
    try {
      const { show } = await api.cloneShow(templateId, { name, includeScenes });
      navigate(`/shows/${show.id}`);
    } catch (err) {
      setError(handleError(err));
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} data-testid="templates">
      <div className={styles.sectionHeader}>
        <h2>Templates</h2>
      </div>
      <ul className={styles.showList} data-testid="template-list">
        {templates.map((s) => (
          <li key={s.id}>
            <Link to={`/shows/${s.id}`}>
              <span className={styles.showListName} title={s.name}>
                {s.name}
              </span>
              <span className={`muted ${styles.showListRole}`}>template</span>
            </Link>
          </li>
        ))}
      </ul>
      {usable.length > 0 && (
        <form
          className={styles.inlineForm}
          onSubmit={onSubmit}
          aria-label="New from template"
          style={{ marginTop: 16 }}
        >
          <label>
            <span>Template</span>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            <span>Name of the copy</span>
            <input name="name" type="text" required maxLength={200} />
          </label>
          <label>
            <span>Scenes</span>
            <input
              type="checkbox"
              checked={includeScenes}
              aria-label="Include scenes"
              onChange={(e) => setIncludeScenes(e.target.checked)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            New from template
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </section>
  );
}

/** A new show: personal, or in one of the teams where you're an editor (or up). */
function NewShowForm({ teams }: { teams: TeamDTO[] }) {
  const handleError = useApiErrorHandler();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const teamId = String(data.get("team") ?? "") || null;
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { show } = await api.createShow(teamId ? { name, teamId } : { name });
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
      {teams.length > 0 && (
        <label>
          <span>Team</span>
          <select name="team" defaultValue="" className={styles.fieldSelect}>
            <option value="">Personal</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="primary" disabled={busy}>
        New show
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function InviteForm({ shows }: { shows: ShowSummaryDTO[] }) {
  const handleError = useApiErrorHandler();
  const [invite, setInvite] = useState<CreateInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const data = new FormData(formEl);
    const email = String(data.get("email") ?? "");
    const showId = String(data.get("show") ?? "");
    const role = String(data.get("role") ?? "editor") as Role;
    setError(null);
    setInvite(null);
    try {
      setInvite(await api.createInvite(showId ? { email, showId, role } : { email }));
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
        <label>
          <span>Join show</span>
          <select name="show" defaultValue="">
            <option value="">No show</option>
            {shows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>As</span>
          <select name="role" defaultValue="editor">
            {GRANTABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
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

/** Admins: a one-time link that lets someone set a new password (R24). */
function ResetLinkForm() {
  const handleError = useApiErrorHandler();
  const [reset, setReset] = useState<CreateResetLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const email = String(new FormData(formEl).get("email") ?? "");
    setError(null);
    setReset(null);
    try {
      setReset(await api.createResetLink(email));
      formEl.reset();
    } catch (err) {
      setError(handleError(err));
    }
  }

  const link = reset ? `${window.location.origin}${reset.path}` : "";
  return (
    <section className={styles.card}>
      <div className={styles.sectionHeader}>
        <h2>Reset a password</h2>
      </div>
      <form className={styles.inlineForm} onSubmit={onSubmit} aria-label="Reset a password">
        <label style={{ flex: 1 }}>
          <span>Account to reset</span>
          <input name="email" type="email" required />
        </label>
        <button type="submit">Create reset link</button>
      </form>
      {error && (
        <p className="error" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      {reset && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="muted" style={{ margin: 0 }}>
            Send this one-time link to {reset.email}. It expires in 24 hours; using it signs them
            out everywhere.
          </p>
          <code className={styles.inviteLink} data-testid="reset-link">
            {link}
          </code>
        </div>
      )}
    </section>
  );
}
