// Airtable CSV import (R25): a file input the workspace keeps mounted for editors, opened
// from Show settings or the ⌘K command, plus the result banner. Uploads the core CSV
// exports to /import/airtable.
import { type ChangeEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
import type { ImportResponse } from "../../shared/ops";
import { DATA_TABLES } from "../../shared/tables";
import { api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import { useShowStoreInstance } from "../lib/show-store";
import styles from "./AirtableImport.module.css";

export interface AirtableImportHandle {
  /** Open the file chooser (needs a user gesture, e.g. a click or keypress). */
  open(): void;
}

export const IMPORT_LABEL = "Import Airtable CSVs…";

export function AirtableImport({
  showId,
  ref,
}: {
  showId: string;
  ref?: Ref<AirtableImportHandle>;
}) {
  const store = useShowStoreInstance();
  const handleError = useApiErrorHandler();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), []);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    // The server refuses (409) to import into a show with data unless told to append.
    const state = store.getState();
    const append = DATA_TABLES.some((t) => state.tables[t].size > 0);
    if (append) {
      const n = state.order.cues.length;
      const ok = window.confirm(
        `This show already has ${n} ${n === 1 ? "cue" : "cues"}. Import anyway? Rows will be added, not merged.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.importAirtable(showId, files, { clientId: store.clientId, append }));
      await store.refresh();
    } catch (err) {
      setError(handleError(err));
    } finally {
      setBusy(false);
    }
  }

  const c = result?.created;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        multiple
        disabled={busy}
        onChange={onChange}
        className={styles.input}
        aria-label={IMPORT_LABEL}
        tabIndex={-1}
      />
      {(busy || c || error) && (
        <div className={styles.banner}>
          {busy && (
            <span role="status" className={styles.result}>
              Importing…
            </span>
          )}
          {c && (
            <div className={styles.result} data-testid="import-result" role="status">
              Imported {c.scenes} scenes, {c.cues} cues, {c.content} content, {c.notes} notes,{" "}
              {c.persons} people.
              {result.warnings.length > 0 && (
                <details>
                  <summary>{result.warnings.length} warnings</summary>
                  <ul>
                    {result.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!busy && (
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Dismiss import result"
              onClick={() => {
                setResult(null);
                setError(null);
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
    </>
  );
}
