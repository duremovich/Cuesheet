// Show settings sections for the show's structure (M5a): custom tables (R9: new, rename,
// reorder, delete), "Export all tables (zip)" (R26) and "Save as template" (R27).
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { customTableRef } from "../../../shared/custom-fields";
import type { CustomTableRow } from "../../../shared/tables";
import { api } from "../../lib/api";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { FieldsManager } from "../custom/FieldsManager";
import {
  customTablesInOrder,
  newCustomTableOps,
  TARGET_LABELS,
  targetTableLabel,
} from "../custom/model";
import { downloadAll } from "../export/exportAll";
import styles from "./ShowWorkspace.module.css";
import { customTabKey } from "./tabs";
import { useWorkspace } from "./workspace";

export function ShowStructureSettings({ close }: { close: () => void }) {
  return (
    <>
      <CustomTablesSettings close={close} />
      <ExportAllSettings />
      <TemplateSettings />
    </>
  );
}

function CustomTablesSettings({ close }: { close: () => void }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const navigate = useNavigate();
  const map = useShowStore((s) => s.tables.custom_tables);
  const rows = useShowStore((s) => s.tables.custom_rows);
  const tables = useMemo(() => customTablesInOrder(map), [map]);
  if (!ws.canEdit && tables.length === 0) return null;
  const send = (ops: Parameters<typeof store.mutate>[0], what: string) =>
    store.mutate(ops).catch((e: unknown) => ws.reportError(e, what));
  const go = (id: string) =>
    navigate(`/shows/${encodeURIComponent(ws.showId)}/${customTabKey(id)}`);
  const swap = (i: number, j: number) => {
    const a = tables[i];
    const b = tables[j];
    if (!a || !b) return;
    const pa = a.position ?? i + 1;
    const pb = b.position ?? j + 1;
    void send(
      [
        {
          op: "update",
          table: "custom_tables",
          id: a.id,
          fields: { position: pb === pa ? pa + (j - i) : pb },
        },
        { op: "update", table: "custom_tables", id: b.id, fields: { position: pa } },
      ],
      "reorder the tables",
    );
  };
  return (
    <section data-testid="custom-tables-settings">
      <h3>Structure</h3>
      <FieldsOfTable tables={tables} canEdit={ws.canEdit} />
      <h4 className={styles.subheading}>Custom tables</h4>
      {tables.length === 0 && <p className="muted">None yet.</p>}
      {tables.length > 0 && (
        <ul className={styles.members}>
          {tables.map((t, i) => {
            const label = t.label || "Untitled table";
            return (
              <li key={t.id}>
                <span className={styles.memberName}>{label}</span>
                {ws.canEdit && (
                  <>
                    <button
                      type="button"
                      aria-label={`Move ${label} up`}
                      disabled={i === 0}
                      onClick={() => swap(i, i - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${label} down`}
                      disabled={i === tables.length - 1}
                      onClick={() => swap(i, i + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename ${label}`}
                      onClick={() => {
                        const next = window.prompt("Rename the table", label)?.trim();
                        if (next && next !== t.label) {
                          void send(
                            [
                              {
                                op: "update",
                                table: "custom_tables",
                                id: t.id,
                                fields: { label: next },
                              },
                            ],
                            "rename the table",
                          );
                        }
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${label}`}
                      onClick={() => {
                        const n = [...rows.values()].filter((r) => r.table_id === t.id).length;
                        // Link fields elsewhere that point at this table go too: say which.
                        const data = store.getState();
                        const ref = customTableRef(t.id);
                        const links = [...data.tables.custom_fields.values()]
                          .filter(
                            (f) => f.type === "link" && f.options.target === ref && f.table !== ref,
                          )
                          .map((f) => `${targetTableLabel(data, f.table)} → ${f.label || f.key}`);
                        const msg = `Delete the table "${label}"${n ? ` and its ${n} ${n === 1 ? "row" : "rows"}` : ""}? Its fields and views go too.${links.length ? ` These link fields on other tables are removed as well: ${links.join(", ")}.` : ""}`;
                        if (!window.confirm(msg)) return;
                        void send(
                          [{ op: "delete", table: "custom_tables", id: t.id }],
                          "delete the table",
                        );
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ws.canEdit && (
        <button
          type="button"
          onClick={() => {
            const label = window.prompt("Name of the new table", "Network")?.trim();
            if (!label) return;
            const { id, ops } = newCustomTableOps(store.getState(), label);
            void send(ops, "add the table");
            close();
            go(id);
          }}
        >
          + New table
        </button>
      )}
    </section>
  );
}

/** Show settings → Structure: the Fields manager for any table (R9). */
function FieldsOfTable({ tables, canEdit }: { tables: CustomTableRow[]; canEdit: boolean }) {
  const [fieldTable, setFieldTable] = useState("cues");
  const choices = [
    ...Object.entries(TARGET_LABELS).map(([value, label]) => ({ value, label })),
    ...tables.map((t) => ({ value: customTableRef(t.id), label: t.label || "Untitled table" })),
  ];
  return (
    <div data-testid="structure-fields">
      <label className={styles.unitRow}>
        <span>Fields of</span>
        <select value={fieldTable} onChange={(e) => setFieldTable(e.target.value)}>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <FieldsManager key={fieldTable} fieldTable={fieldTable} canEdit={canEdit} />
    </div>
  );
}

function ExportAllSettings() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = ws.role === "owner";
  return (
    <section>
      <h3>Export</h3>
      {isOwner && (
        <label className={styles.unitRow}>
          <span>Include sensitive fields</span>
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
          />
        </label>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          downloadAll(store.getState(), ws.showName, { includeSensitive: isOwner && sensitive })
            .catch((e: unknown) => ws.reportError(e, "export the show"))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Exporting…" : "Export all tables (zip)"}
      </button>
    </section>
  );
}

function TemplateSettings() {
  const ws = useWorkspace();
  const [name, setName] = useState(`${ws.showName} template`);
  const [includeScenes, setIncludeScenes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!ws.canEdit) return null;
  return (
    <section>
      <h3>Template</h3>
      <form
        className={styles.addMember}
        aria-label="Save as template"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          setBusy(true);
          setDone(null);
          api
            .cloneShow(ws.showId, { name: n, includeScenes, asTemplate: true })
            .then((r) => {
              setDone(r.show.name);
              ws.toast(`Saved the template "${r.show.name}"`);
            })
            .catch((err: unknown) => ws.reportError(err, "save the template"))
            .finally(() => setBusy(false));
        }}
      >
        <input
          value={name}
          maxLength={200}
          aria-label="Template name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save as template"}
        </button>
      </form>
      <label className={styles.unitRow}>
        <span>Include scenes</span>
        <input
          type="checkbox"
          checked={includeScenes}
          onChange={(e) => setIncludeScenes(e.target.checked)}
        />
      </label>
      <p className="muted">
        Copies surfaces, scenes, custom fields and tables, views and the default unit; never cues,
        notes, content, shots or files.
        {done ? ` Saved "${done}": it's under Templates on the shows page.` : ""}
      </p>
    </section>
  );
}
