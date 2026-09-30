// The row panel's History tab (R15): GET /history for one record, newest first, "who changed
// what: from → to, when", with Load more. Refetches shortly after the show changes while
// it's open, so your own edits show up.
import { useEffect, useMemo, useState } from "react";
import type { HistoryEntry } from "../../../shared/ops";
import type { TableName } from "../../../shared/tables";
import { api } from "../../lib/api";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { formatTimestamp } from "../notes/columns";
import { useWorkspace } from "../show/workspace";
import { type FieldLabels, formatHistory, HIDDEN_HISTORY_FIELDS, historySentence } from "./history";
import styles from "./RowPanel.module.css";

const PAGE = 50;

export function PanelHistory({
  table,
  id,
  labels,
}: {
  table: TableName;
  id: string;
  labels: FieldLabels;
}) {
  const { showId, memberNames } = useWorkspace();
  const store = useShowStoreInstance();
  const version = useShowStore((s) => s.version);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ key: string; changes: HistoryEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${table}:${id}`;

  // A different record starts from the first page again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the record changes
  useEffect(() => setLimit(PAGE), [key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` triggers a refetch
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        api
          .history(showId, { table, id, limit })
          .then((r) => {
            if (!live) return;
            setResult({ key, changes: r.changes });
            setError(null);
          })
          .catch((e: unknown) => {
            if (live) setError(e instanceof Error ? e.message : String(e));
          });
      },
      result ? 400 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [showId, table, id, limit, version, key]);

  const changes = result?.key === key ? result.changes : null;
  const lines = useMemo(() => {
    const data = store.getState();
    return (changes ?? [])
      .filter((c) => !HIDDEN_HISTORY_FIELDS.has(c.field))
      .map((c) => formatHistory(c, data, labels, memberNames));
  }, [changes, store, labels, memberNames]);

  if (error && !changes) return <p className="error">Couldn't load the history: {error}</p>;
  if (!changes) return <p className="muted">Loading history…</p>;
  if (lines.length === 0) return <p className="muted">No changes recorded yet.</p>;
  return (
    <>
      <ol className={styles.history} aria-label="History" data-testid="history">
        {lines.map((l) => (
          <li key={l.key} aria-label={historySentence(l)}>
            <span className={styles.historyWhat}>
              <strong>{l.who}</strong>{" "}
              {l.kind === "changed" ? (
                <>
                  changed <strong>{l.field}</strong>:{" "}
                  <span className={styles.historyFrom}>{l.from || "—"}</span> → {l.to || "—"}
                </>
              ) : l.kind === "linked" || l.kind === "unlinked" ? (
                <>
                  {l.kind === "linked" ? "added" : "removed"} {l.to} ({l.field})
                </>
              ) : (
                <>{l.kind} this</>
              )}
            </span>
            <span className={styles.historyWhen}>{formatTimestamp(l.when)}</span>
          </li>
        ))}
      </ol>
      {changes.length >= limit && (
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setLimit((n) => Math.min(n + PAGE, 1000))}
          disabled={limit >= 1000}
        >
          Load more
        </button>
      )}
    </>
  );
}
