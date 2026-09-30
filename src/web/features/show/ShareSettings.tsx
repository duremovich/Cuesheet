// Show settings → Sharing (R23, editors and the owner): read-only links to one table (as
// a view) or a print layout, opened without signing in at /s/<token>. The page says plainly
// that a link shows the whole table, not just the view's filtered rows. Pick what to share,
// optionally an expiry and a label; the link is shown once (the server keeps only its hash;
// this browser remembers the ones it made so they can be copied again,
// ShareSettingsTokens.ts); "Regenerate" gives a live link a new token. Revoking closes open
// viewers at once.
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { SHARE_PRESETS, type ShareLinkDTO, type SharePreset } from "../../../shared/share";
import type { DataTableName } from "../../../shared/tables";
import { api } from "../../lib/api";
import { useApiErrorHandler } from "../../lib/auth";
import { useShowStore } from "../../lib/show-store";
import styles from "./ShareSettings.module.css";
import { forgetLink, rememberedLinks, rememberLink, shareUrl } from "./ShareSettingsTokens";
import { TABS } from "./tabs";
import { useWorkspace } from "./workspace";

const DAY = 24 * 60 * 60 * 1000;
const EXPIRY = [
  { value: "", label: "Never" },
  { value: String(DAY), label: "1 day" },
  { value: String(7 * DAY), label: "7 days" },
  { value: String(30 * DAY), label: "30 days" },
] as const;

/** One pickable target: a table's shared view, or a built-in layout. */
interface Target {
  key: string;
  label: string;
  table: DataTableName;
  viewId: string | null;
  preset: SharePreset | null;
}

function describe(link: ShareLinkDTO, viewName: (id: string) => string | undefined): string {
  if (link.preset) {
    const p = SHARE_PRESETS[link.preset].label;
    return link.options.session ? `${p} · ${link.options.session}` : p;
  }
  const tab = TABS.find((t) => t.table === link.table)?.label ?? link.table;
  const view = link.viewId ? (viewName(link.viewId) ?? "a deleted view") : "default view";
  return `${tab} · ${view}${link.kind === "print" ? " (print)" : ""}`;
}

function status(link: ShareLinkDTO): "active" | "revoked" | "expired" {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt <= Date.now()) return "expired";
  return "active";
}

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SharingSection() {
  const ws = useWorkspace();
  const handleError = useApiErrorHandler();
  const views = useShowStore((s) => s.tables.views);
  const currentSession = useShowStore((s) => s.show?.currentSession ?? null);
  const [links, setLinks] = useState<ShareLinkDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [known, setKnown] = useState(() => rememberedLinks(ws.showId));

  const load = useCallback(() => {
    api
      .shareLinks(ws.showId)
      .then((r) => setLinks(r.links))
      .catch((e: unknown) => setError(handleError(e)));
  }, [ws.showId, handleError]);
  useEffect(load, [load]);

  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    for (const tab of TABS) {
      const shared = [...views.values()]
        .filter((v) => v.table === tab.table && v.owner_user_id === null)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      for (const v of shared) {
        out.push({
          key: `view:${v.id}`,
          label: `${tab.label} · ${v.name || "Untitled view"}`,
          table: tab.table,
          viewId: v.id,
          preset: null,
        });
      }
    }
    for (const [preset, p] of Object.entries(SHARE_PRESETS) as [
      SharePreset,
      (typeof SHARE_PRESETS)[SharePreset],
    ][]) {
      out.push({ key: `preset:${preset}`, label: p.label, table: p.table, viewId: null, preset });
    }
    return out;
  }, [views]);
  const [targetKey, setTargetKey] = useState("");
  const target = targets.find((t) => t.key === targetKey) ?? targets[0];
  const notesPreset = target?.preset === "by-person" || target?.preset === "by-cue";

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!target) return;
    const form = new FormData(e.currentTarget);
    const expiry = String(form.get("expiry") ?? "");
    const session = String(form.get("session") ?? "").trim();
    setError(null);
    setCreated(null);
    try {
      const made = await api.createShareLink(ws.showId, {
        kind: target.preset ? "print" : form.get("print") === "on" ? "print" : "view",
        table: target.table,
        viewId: target.viewId,
        preset: target.preset,
        label: String(form.get("label") ?? "").trim() || null,
        expiresAt: expiry ? Date.now() + Number(expiry) : null,
        options: notesPreset && session ? { session } : {},
      });
      rememberLink(ws.showId, made.link.id, made.path);
      setKnown(rememberedLinks(ws.showId));
      setCreated({ id: made.link.id, url: shareUrl(made.path) });
      load();
    } catch (err) {
      setError(handleError(err));
    }
  };

  const copy = (id: string, url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(id),
      () => undefined,
    );
  };

  const regenerate = async (link: ShareLinkDTO) => {
    if (!window.confirm("Make a new link with the same settings? The current one stops working.")) {
      return;
    }
    setError(null);
    try {
      const made = await api.regenerateShareLink(ws.showId, link.id);
      forgetLink(ws.showId, link.id);
      rememberLink(ws.showId, made.link.id, made.path);
      setKnown(rememberedLinks(ws.showId));
      setCreated({ id: made.link.id, url: shareUrl(made.path) });
      load();
    } catch (err) {
      setError(handleError(err));
    }
  };

  const revoke = async (link: ShareLinkDTO) => {
    if (!window.confirm("Revoke this link? Anyone viewing it is disconnected at once.")) return;
    setError(null);
    try {
      await api.revokeShareLink(ws.showId, link.id);
      forgetLink(ws.showId, link.id);
      setKnown(rememberedLinks(ws.showId));
      if (created?.id === link.id) setCreated(null);
      load();
    } catch (err) {
      setError(handleError(err));
    }
  };

  const viewName = (id: string) => views.get(id)?.name ?? undefined;

  return (
    <section data-testid="sharing">
      <h3>Sharing</h3>
      <p className={styles.hint}>
        Read-only links for people without an account (SM, director). Anyone with the link can see
        what it shows, live.
      </p>
      <form className={styles.form} onSubmit={onCreate} aria-label="New share link">
        <label>
          Share
          <select
            name="target"
            aria-label="What to share"
            value={target?.key ?? ""}
            onChange={(e) => setTargetKey(e.target.value)}
          >
            <optgroup label="Views">
              {targets
                .filter((t) => !t.preset)
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Print layouts">
              {targets
                .filter((t) => t.preset)
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        {target && (
          <p className={styles.scopeNote} data-testid="share-scope-note">
            {target.preset
              ? "This link shows the chosen layout, live."
              : `This link shows the whole ${
                  TABS.find((t) => t.table === target.table)?.label ?? target.table
                } table (live) or the chosen layout — not just this view's filtered rows.`}
          </p>
        )}
        {target && !target.preset && (
          <label className={styles.check}>
            <input type="checkbox" name="print" /> As a print layout (instead of the live table)
          </label>
        )}
        {notesPreset && (
          <label>
            Session
            <input
              name="session"
              defaultValue={currentSession ?? ""}
              placeholder="All sessions"
              aria-label="Session"
            />
          </label>
        )}
        <div className={styles.row}>
          <label>
            Expires
            <select name="expiry" aria-label="Expires" defaultValue="">
              {EXPIRY.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.grow}>
            Label
            <input name="label" placeholder="e.g. For the SM" aria-label="Label" maxLength={200} />
          </label>
        </div>
        <button type="submit">Create link</button>
      </form>
      {created && (
        <div className={styles.created} data-testid="share-new-link">
          <p>Copy it now: only this browser can show it again.</p>
          <code>{created.url}</code>
          <button type="button" onClick={() => copy(created.id, created.url)}>
            {copied === created.id ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {links === null && !error && <p className="muted">Loading…</p>}
      {links && links.length > 0 && (
        <ul className={styles.links} data-testid="share-links">
          {links.map((l) => {
            const st = status(l);
            const path = known[l.id];
            return (
              <li key={l.id} data-status={st}>
                <div className={styles.linkText}>
                  <strong>{l.label || describe(l, viewName)}</strong>
                  {l.label && <span className="muted"> · {describe(l, viewName)}</span>}
                  <span className={styles.meta}>
                    {st === "active"
                      ? l.expiresAt
                        ? `Expires ${when(l.expiresAt)}`
                        : "No expiry"
                      : st === "revoked"
                        ? "Revoked"
                        : "Expired"}
                    {l.lastUsedAt ? ` · last opened ${when(l.lastUsedAt)}` : " · not opened yet"}
                  </span>
                </div>
                {st === "active" && path && (
                  <button type="button" onClick={() => copy(l.id, shareUrl(path))}>
                    {copied === l.id ? "Copied" : "Copy"}
                  </button>
                )}
                {st === "active" && (
                  <button
                    type="button"
                    aria-label={`Regenerate ${l.label || describe(l, viewName)}`}
                    title="A new link with the same settings; the current one stops working"
                    onClick={() => void regenerate(l)}
                  >
                    Regenerate
                  </button>
                )}
                {st === "active" && (
                  <button
                    type="button"
                    data-destructive=""
                    aria-label={`Revoke ${l.label || describe(l, viewName)}`}
                    onClick={() => void revoke(l)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
