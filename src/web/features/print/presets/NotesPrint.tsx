// Notes by person / Notes by cue (R21, S3):
// `/shows/:id/print/notes?preset=by-person|by-cue&session=&person=&breaks=1`.
// By person: one section per assignee (open notes first, then cue order), a tick box per
// note for ticking off by hand, optionally a page per person; "Distribute notes" gives an
// email per assignee (mailto:, with the share link when there is one). By cue: cue headings
// in show order with their notes beneath. `session` filters (absent: every session).
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ShareLinkDTO } from "../../../../shared/share";
import { api } from "../../../lib/api";
import { type ShowState, useShowStore } from "../../../lib/show-store";
import { isOpen } from "../../notes/compose";
import { useShareMode } from "../../share/context";
import { rememberedLinks, rememberLink, shareUrl } from "../../show/ShareSettingsTokens";
import { useWorkspace } from "../../show/workspace";
import styles from "../Print.module.css";
import { PrintShell, printDate, useOrientation } from "../PrintShell";
import {
  cueNumbers,
  groupByCue,
  groupByPerson,
  mailtoHref,
  type NoteGroup,
  type NotePrintRow,
  noteRows,
  noteSessions,
  notesEmailBody,
  typeText,
} from "./notes";

export type NotesPreset = "by-person" | "by-cue";

const selectState = (s: ShowState) => s;

export function notesPrintUrl(
  showId: string,
  preset: NotesPreset,
  opts: { session?: string | null; person?: string | null } = {},
): string {
  const p = new URLSearchParams({ preset });
  if (opts.session) p.set("session", opts.session);
  if (opts.person) p.set("person", opts.person);
  return `/shows/${encodeURIComponent(showId)}/print/notes?${p}`;
}

/** Local state that writes its URL parameter (replace) as it changes. */
function useParamState(name: string): [string | null, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const url = params.get(name);
  const [value, setValue] = useState(url);
  // A navigation elsewhere (a link to the same page) wins once the router applies it.
  useEffect(() => setValue(url), [url]);
  const set = (v: string | null) => {
    setValue(v);
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (v === null || v === "") p.delete(name);
        else p.set(name, v);
        return p;
      },
      { replace: true },
    );
  };
  return [value, set];
}

export function NotesPrint({ preset }: { preset: NotesPreset }) {
  const ws = useWorkspace();
  const share = useShareMode();
  // A share link that fixes the session / person (enforced by the server) hides its picker.
  const fixed = share?.options ?? {};
  const state = useShowStore(selectState);
  const [orientation, setOrientation] = useOrientation("portrait");
  const [session, setSession] = useParamState("session");
  const [person, setPerson] = useParamState("person");
  const [breaks, setBreaks] = useParamState("breaks");
  const [distribute, setDistribute] = useState(false);
  const sessions = useMemo(() => noteSessions(state), [state]);
  const rows = useMemo(() => noteRows(state, session), [state, session]);
  const groups = useMemo(
    () => (preset === "by-person" ? groupByPerson(rows, person) : groupByCue(rows, state)),
    [preset, rows, person, state],
  );
  const allPeople = useMemo(
    () => (preset === "by-person" ? groupByPerson(rows) : []),
    [preset, rows],
  );
  const title = preset === "by-person" ? "Notes by person" : "Notes by cue";
  const sessionText = session ?? "All sessions";
  const open = rows.filter((r) => isOpen(r.note)).length;
  const other = preset === "by-person" ? "by-cue" : "by-person";

  const columns: { key: string; title: string; cell: (r: NotePrintRow) => string }[] = [
    ...(preset === "by-person" ? [{ key: "cue", title: "Cue", cell: cueNumbers }] : []),
    { key: "body", title: "Note", cell: (r) => r.note.body ?? "(photo)" },
    ...(preset === "by-cue"
      ? [{ key: "who", title: "Assigned", cell: (r: NotePrintRow) => names(r) }]
      : []),
    { key: "type", title: "Type", cell: (r) => typeText(r.note) },
    { key: "priority", title: "P", cell: (r) => r.note.priority ?? "" },
    { key: "status", title: "Status", cell: (r) => r.note.status ?? "Open" },
    ...(session === null ? [{ key: "session", title: "Session", cell: sessionOf }] : []),
  ];

  return (
    <PrintShell
      title={title}
      back={`/shows/${encodeURIComponent(ws.showId)}/notes`}
      testId="print-notes"
      orientation={orientation}
      onOrientation={setOrientation}
      running={{
        title: `${ws.showName} · ${title}`,
        footer: `${ws.showName} · ${sessionText} · ${printDate()}`,
      }}
      subtitle={
        <span data-testid="print-notes-summary">
          {sessionText} · {rows.length} {rows.length === 1 ? "note" : "notes"}, {open} open
        </span>
      }
      controls={
        <>
          {!fixed.session && (
            <label className={styles.control}>
              Session{" "}
              <select
                aria-label="Session"
                value={session ?? ""}
                onChange={(e) => setSession(e.target.value || null)}
              >
                <option value="">All sessions</option>
                {sessions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {session && !sessions.includes(session) && (
                  <option value={session}>{session}</option>
                )}
              </select>
            </label>
          )}
          {preset === "by-person" && (
            <>
              {!fixed.person && (
                <label className={styles.control}>
                  Person{" "}
                  <select
                    aria-label="Person"
                    value={person ?? ""}
                    onChange={(e) => setPerson(e.target.value || null)}
                  >
                    <option value="">Everyone</option>
                    {allPeople.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={styles.control}>
                <input
                  type="checkbox"
                  checked={breaks === "1"}
                  onChange={(e) => setBreaks(e.target.checked ? "1" : null)}
                />{" "}
                A page per person
              </label>
              {!share && (
                <button
                  type="button"
                  aria-expanded={distribute}
                  onClick={() => setDistribute((d) => !d)}
                  data-testid="distribute-notes"
                >
                  Distribute notes
                </button>
              )}
            </>
          )}
          {!share && (
            <Link
              to={notesPrintUrl(ws.showId, other, { session })}
              data-testid="print-switch-layout"
            >
              {other === "by-cue" ? "Notes by cue instead" : "Notes by person instead"}
            </Link>
          )}
        </>
      }
    >
      {distribute && preset === "by-person" && (
        <Distribute groups={allPeople} session={session} onClose={() => setDistribute(false)} />
      )}
      {groups.length === 0 && <p className="muted">No notes{session ? ` in ${session}` : ""}.</p>}
      {groups.map((g, i) => (
        <table
          key={g.id}
          className={styles.table}
          data-testid="print-group"
          data-break={preset === "by-person" && breaks === "1" && i > 0 ? "" : undefined}
        >
          <thead>
            <tr className={styles.groupRow}>
              <th colSpan={columns.length + 1}>
                {g.title}
                {g.subtitle ? <span className={styles.groupSub}> · {g.subtitle}</span> : null}
                <span className={styles.groupSub}>
                  {" "}
                  ({g.rows.filter((r) => isOpen(r.note)).length} open of {g.rows.length})
                </span>
              </th>
            </tr>
            <tr>
              <th scope="col" className={styles.tickCell}>
                <span className={styles.srOnly}>Done</span>
              </th>
              {columns.map((c) => (
                <th key={c.key} scope="col" data-nowrap={c.key !== "body" || undefined}>
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.rows.map((r) => (
              <tr key={r.note.id} data-testid="print-row" data-open={isOpen(r.note) || undefined}>
                <td className={styles.tickCell}>
                  <span className={styles.tickBox} aria-hidden="true" />
                </td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-num={c.key === "cue" || c.key === "priority" || undefined}
                    className={c.key === "body" ? styles.noteBody : undefined}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </PrintShell>
  );
}

const names = (r: NotePrintRow) => r.assignees.map((p) => p.name ?? "").join(", ");
const sessionOf = (r: NotePrintRow) => r.note.session ?? "";

/**
 * "Distribute notes": per assignee, an email (mailto:, to their People email) with their
 * notes as text and — when this show has a "Notes by person" share link this browser
 * knows — a link to their printable list; and a link to print just their notes.
 */
function Distribute({
  groups,
  session,
  onClose,
}: {
  groups: NoteGroup[];
  session: string | null;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const canShare = ws.canEdit; // editors and the owner manage share links
  const [links, setLinks] = useState<ShareLinkDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState(() => rememberedLinks(ws.showId));
  useEffect(() => {
    if (!canShare) return;
    api
      .shareLinks(ws.showId)
      .then((r) => setLinks(r.links))
      .catch(() => setLinks([]));
  }, [canShare, ws.showId]);
  const people = groups.filter((g) => g.person);
  /** This person's live link for this session (session + person enforced by the server). */
  const pathFor = (personId: string): string | undefined => {
    const link = (links ?? []).find(
      (l) =>
        l.preset === "by-person" &&
        l.revokedAt === null &&
        (l.expiresAt === null || l.expiresAt > Date.now()) &&
        (l.options.session ?? null) === session &&
        l.options.person === personId &&
        known[l.id],
    );
    return link ? known[link.id] : undefined;
  };
  const missing = people.filter((g) => !pathFor(g.id));
  const subject = `${ws.showName} notes${session ? ` – ${session}` : ""}`;

  // One link per recipient: each sees only their own notes for this session.
  const createAll = async () => {
    setError(null);
    setBusy(true);
    try {
      const made: ShareLinkDTO[] = [];
      for (const g of missing) {
        const r = await api.createShareLink(ws.showId, {
          kind: "print",
          table: "notes",
          preset: "by-person",
          options: session ? { session, person: g.id } : { person: g.id },
          label: `${g.title} – ${subject}`,
        });
        rememberLink(ws.showId, r.link.id, r.path);
        made.push(r.link);
      }
      setKnown(rememberedLinks(ws.showId));
      setLinks((l) => [...made, ...(l ?? [])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={styles.distribute}
      data-testid="distribute-panel"
      aria-label="Distribute notes"
    >
      <div className={styles.distributeHead}>
        <h2>Distribute notes{session ? ` – ${session}` : ""}</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="muted">
        {canShare ? (
          <>
            Each email can carry a personal read-only link: each recipient sees only their notes
            {session ? ` for ${session}` : ""}.{" "}
            {missing.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void createAll()}
                data-testid="distribute-create-link"
              >
                Create {missing.length === 1 ? "a link" : `${missing.length} links`}
              </button>
            )}
          </>
        ) : (
          "Emails carry the notes as text (an editor can add personal links)."
        )}
      </p>
      {error && <p className="error">{error}</p>}
      <ul className={styles.distributeList}>
        {people.map((g) => {
          const path = pathFor(g.id);
          const personal = path ? shareUrl(path) : null;
          const body = notesEmailBody(g, { show: ws.showName, session, link: personal });
          return (
            <li key={g.id} data-testid="distribute-person">
              <span>
                {g.title}{" "}
                <span className="muted">({g.rows.filter((r) => isOpen(r.note)).length} open)</span>
              </span>
              <a href={mailtoHref(g.person?.email ?? null, subject, body)}>
                Email{g.person?.email ? "" : " (no address)"}
              </a>
              {personal && (
                <code className={styles.personalLink} data-testid="distribute-share-link">
                  {personal}
                </code>
              )}
              <Link to={notesPrintUrl(ws.showId, "by-person", { session, person: g.id })}>
                Print only theirs
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
