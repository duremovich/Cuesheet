// "Add people" for a show (Show settings → Members) or a team (the team page): one email
// and a role capped to what you may grant. An existing account is added at once, an
// unknown email gets an invite (POST /shows/:id/people, /teams/:id/people). The result
// says which and whether the email went out; an invite's link (shown only now and after a
// reissue: the server keeps only its hash) goes to its row in the pending list.
import { type FormEvent, useEffect, useId, useState } from "react";
import type { InvitedDTO, PeopleResponse } from "../../../shared/api";
import { api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import { shortDate } from "../../lib/relativeTime";
import styles from "./Teams.module.css";

/** What both add-people routes answer (show and team members differ only in extra fields). */
export type AddPeopleResult =
  | { added: { name: string; email: string; role: string }; emailed: boolean }
  | { invited: InvitedDTO; emailed: boolean };

type Person = PeopleResponse["people"][number];

/** Everyone you share a show or team with, for the email field's suggestions. */
function usePeople(): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let live = true;
    api
      .people()
      .then((r) => {
        if (live) setPeople(r.people);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return people;
}

export function AddPeople<R extends string>({
  roles,
  add,
  targetPath,
  exclude,
  onDone,
  onInvited,
}: {
  /** The roles you may grant here, highest first. */
  roles: readonly R[];
  add: (email: string, role: R) => Promise<AddPeopleResult>;
  /** The show or team page (the link to copy for someone added at once). */
  targetPath: string;
  /** Emails already in (not suggested). */
  exclude: ReadonlySet<string>;
  /** After anything was added or invited (reload the members and invites). */
  onDone: () => void;
  /** A new invite's one-time link, so the pending list can offer it too. */
  onInvited: (inviteId: string, path: string) => void;
}) {
  const handleError = useApiErrorHandler();
  const people = usePeople();
  const listId = useId();
  const [result, setResult] = useState<AddPeopleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const defaultRole = roles.includes("editor" as R) ? ("editor" as R) : roles[0];

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const role = String(data.get("role") ?? defaultRole) as R;
    if (!email) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await add(email, role);
      if ("invited" in r) onInvited(r.invited.id, r.invited.path);
      setResult(r);
      form.reset();
      onDone();
    } catch (err) {
      setError(handleError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.addPeople}>
      <form className={styles.addForm} onSubmit={onSubmit} aria-label="Add people">
        <input
          type="email"
          name="email"
          placeholder="Email"
          aria-label="Email"
          list={listId}
          autoComplete="off"
          required
        />
        <datalist id={listId}>
          {people
            .filter((p) => !exclude.has(p.email))
            .map((p) => (
              <option key={p.id} value={p.email}>
                {p.name}
              </option>
            ))}
        </datalist>
        <select name="role" aria-label="Role" defaultValue={defaultRole}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          Add
        </button>
      </form>
      {result && <AddResult result={result} targetPath={targetPath} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * What adding did. An invite's link isn't repeated here: it's on the invite's row in the
 * pending list (where a reissue puts the new one too).
 */
function AddResult({ result, targetPath }: { result: AddPeopleResult; targetPath: string }) {
  if ("invited" in result) {
    return (
      <div className={styles.result} role="status" data-testid="add-people-result">
        <p>
          <strong>Invite created</strong> for {result.invited.email} as {result.invited.role}, valid
          until {shortDate(result.invited.expiresAt)}.{" "}
          {result.emailed ? "Email sent." : "Email not sent: copy the link below."}
        </p>
      </div>
    );
  }
  const link = `${window.location.origin}${targetPath}`;
  return (
    <div className={styles.result} role="status" data-testid="add-people-result">
      <p>
        <strong>Added</strong> {result.added.name} as {result.added.role}.{" "}
        {result.emailed ? "Email sent." : "Email not sent: copy the link."}
      </p>
      <code>{link}</code>
      <CopyButton text={link} />
    </div>
  );
}

/** "Copy link" → "Copied". */
export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
