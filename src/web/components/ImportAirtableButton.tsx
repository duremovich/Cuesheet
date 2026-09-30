// "Import Airtable CSVs…": uploads the core CSV exports to /import/airtable (R25).
import { type ChangeEvent, useState } from "react";
import type { ImportResponse } from "../../shared/ops";
import { api } from "../lib/api";
import { useApiErrorHandler } from "../lib/auth";
import { useShowStoreInstance } from "../lib/show-store";
import styles from "./ImportAirtableButton.module.css";

export function ImportAirtableButton({ showId }: { showId: string }) {
  const store = useShowStoreInstance();
  const handleError = useApiErrorHandler();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.importAirtable(showId, files, store.clientId));
      await store.refresh();
    } catch (err) {
      setError(handleError(err));
    } finally {
      setBusy(false);
    }
  }

  const c = result?.created;
  return (
    <div className={styles.wrap}>
      <label className={styles.button} aria-disabled={busy}>
        {busy ? "Importing…" : "Import Airtable CSVs…"}
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={busy}
          onChange={onChange}
          className={styles.input}
        />
      </label>
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
    </div>
  );
}
