// Airtable CSV import (R25): a file input the workspace keeps mounted for editors, opened
// from Show settings or the ⌘K command; a preview of what the files become (core tables,
// columns Cuesheet doesn't map with "Create custom field" and a guessed type, other CSVs as
// custom tables with their field types, R9); then the upload to /import/airtable and the
// result banner.
import { type ChangeEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
import {
  detectKind,
  IMPORT_KIND_LABELS,
  type ImportKind,
  type ImportMapping,
  tableLabelFromFile,
  unmappedColumns,
} from "../../shared/airtable-columns";
import {
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  guessFieldType,
} from "../../shared/custom-fields";
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

/** Types offered for imported columns (files, links and formulas can't come from a CSV). */
const IMPORTABLE_TYPES = CUSTOM_FIELD_TYPES.filter(
  (t) => t !== "link" && t !== "formula" && t !== "attachment",
);

interface ColumnChoice {
  column: string;
  type: CustomFieldType;
  sensitive: boolean;
  create: boolean;
}

interface FilePreview {
  file: File;
  rows: number;
  kind: ImportKind | null;
  /** Core CSV: unmapped columns (create a custom field?). Other CSV: the table's fields. */
  columns: ColumnChoice[];
  /** Other CSV: the custom table's name, or skip it. */
  label: string;
  skip: boolean;
}

async function previewFiles(files: File[]): Promise<FilePreview[]> {
  const { default: Papa } = await import("papaparse");
  return Promise.all(
    files.map(async (file) => {
      const text = (await file.text()).replace(/^﻿/, "");
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
      });
      const headers = (parsed.meta.fields ?? []).filter((h) => h.trim());
      const rows = parsed.data;
      const kind = detectKind(file.name, headers);
      const cols = kind ? unmappedColumns(kind, headers) : headers;
      return {
        file,
        rows: rows.length,
        kind,
        columns: cols.map((column) => {
          const g = guessFieldType(
            column,
            rows.map((r) => r[column] ?? ""),
          );
          return {
            column,
            type: g.type === "attachment" && kind ? "text" : g.type,
            sensitive: g.options.sensitive === true,
            create: false,
          };
        }),
        label: tableLabelFromFile(file.name),
        skip: false,
      };
    }),
  );
}

/** The request's `mapping` from the preview. */
export function mappingOf(previews: readonly FilePreview[]): ImportMapping {
  const columns: NonNullable<ImportMapping["columns"]> = [];
  const tables: NonNullable<ImportMapping["tables"]> = [];
  for (const p of previews) {
    if (p.kind) {
      for (const c of p.columns) {
        if (c.create) columns.push({ file: p.file.name, column: c.column, type: c.type });
      }
    } else {
      tables.push({
        file: p.file.name,
        label: p.label,
        ...(p.skip ? { skip: true } : {}),
        types: Object.fromEntries(p.columns.map((c) => [c.column, c.type])),
      });
    }
  }
  return { columns, tables };
}

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
  const [preview, setPreview] = useState<FilePreview[] | null>(null);

  useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), []);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);
    setResult(null);
    try {
      setPreview(await previewFiles(files));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runImport(previews: FilePreview[]) {
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
    setPreview(null);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.importAirtable(
          showId,
          previews.map((p) => p.file),
          { clientId: store.clientId, append, mapping: mappingOf(previews) },
        ),
      );
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
      {preview && (
        <ImportPreview
          previews={preview}
          onChange={setPreview}
          onImport={() => void runImport(preview)}
          onCancel={() => setPreview(null)}
        />
      )}
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
              {c.persons} people
              {c.custom_tables
                ? `, ${c.custom_tables} custom ${c.custom_tables === 1 ? "table" : "tables"} (${c.custom_rows} rows)`
                : ""}
              {c.custom_fields
                ? `, ${c.custom_fields} custom ${c.custom_fields === 1 ? "field" : "fields"}`
                : ""}
              .
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

function ImportPreview({
  previews,
  onChange,
  onImport,
  onCancel,
}: {
  previews: FilePreview[];
  onChange: (p: FilePreview[]) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const set = (i: number, patch: Partial<FilePreview>) =>
    onChange(previews.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setCol = (i: number, k: number, patch: Partial<ColumnChoice>) => {
    const p = previews[i];
    if (!p) return;
    set(i, { columns: p.columns.map((c, j) => (j === k ? { ...c, ...patch } : c)) });
  };
  return (
    <section className={styles.preview} aria-label="Import preview" data-testid="import-preview">
      <h2 className={styles.previewTitle}>Import preview</h2>
      {previews.map((p, i) => (
        <div key={p.file.name} className={styles.file} data-testid="import-file">
          <p className={styles.fileHead}>
            <strong>{p.file.name}</strong>{" "}
            <span className="muted">
              · {p.rows} {p.rows === 1 ? "row" : "rows"} →{" "}
              {p.kind ? IMPORT_KIND_LABELS[p.kind] : p.skip ? "skipped" : "a new custom table"}
            </span>
          </p>
          {!p.kind && (
            <div className={styles.tableRow}>
              <label>
                <span>Table name</span>
                <input
                  value={p.label}
                  maxLength={100}
                  disabled={p.skip}
                  aria-label={`Table name for ${p.file.name}`}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={p.skip}
                  onChange={(e) => set(i, { skip: e.target.checked })}
                />
                Skip this file
              </label>
            </div>
          )}
          {p.columns.length > 0 && !p.skip && (
            <table className={styles.columns}>
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  {p.kind && <th scope="col">Create custom field</th>}
                  <th scope="col">Type</th>
                </tr>
              </thead>
              <tbody>
                {p.columns.map((c, k) => (
                  <tr key={c.column}>
                    <td>
                      {c.column}
                      {c.sensitive && <span className="muted"> (sensitive)</span>}
                    </td>
                    {p.kind && (
                      <td>
                        <input
                          type="checkbox"
                          checked={c.create}
                          aria-label={`Create custom field ${c.column}`}
                          onChange={(e) => setCol(i, k, { create: e.target.checked })}
                        />
                      </td>
                    )}
                    <td>
                      <select
                        value={c.type}
                        aria-label={`Type of ${c.column}`}
                        disabled={!!p.kind && !c.create}
                        onChange={(e) => setCol(i, k, { type: e.target.value as CustomFieldType })}
                      >
                        {(p.kind
                          ? IMPORTABLE_TYPES
                          : CUSTOM_FIELD_TYPES.filter((t) => t !== "link" && t !== "formula")
                        ).map((t) => (
                          <option key={t} value={t}>
                            {CUSTOM_FIELD_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {p.kind && p.columns.length > 0 && (
            <p className="muted">
              Columns Cuesheet doesn't map are skipped unless you create a custom field for them.
            </p>
          )}
        </div>
      ))}
      <div className={styles.previewActions}>
        <button type="button" className="primary" onClick={onImport}>
          Import
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
