// The Fields manager (R9), in the view bar's Fields popover: the table's custom fields with
// "+ Add field", edit (name, type, options) and delete (with a confirmation that says how
// many rows have values). Editors and owners; everyone else sees the list only.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  type CustomFieldOptions,
  type CustomFieldType,
  type CustomOption,
  keepsValues,
} from "../../../shared/custom-fields";
import { isFormulaError } from "../../../shared/formula";
import type { CustomFieldRow } from "../../../shared/tables";
import { OPTION_COLORS } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace } from "../show/workspace";
import styles from "../views/ViewBar.module.css";
import { compileCached } from "./formula";
import { lookupFieldColumns, lookupLinkColumns, lookupSummary } from "./lookup";
import {
  customRowsOf,
  fieldsFor,
  linkTargets,
  newFieldOps,
  targetTableLabel,
  valueCount,
} from "./model";

interface Draft {
  id: string | null;
  label: string;
  type: CustomFieldType;
  choices: CustomOption[];
  /** Each choice's stored value when the form opened (null: added now), for renames. */
  originals: (string | null)[];
  target: string;
  multiple: boolean;
  formula: string;
  decimals: string;
  sensitive: boolean;
  /** lookup: the link column to go through, and the linked table's column to show. */
  link: string;
  field: string;
}

const EMPTY: Omit<Draft, "id"> = {
  label: "",
  type: "text",
  choices: [],
  originals: [],
  target: "persons",
  multiple: true,
  formula: "",
  decimals: "",
  sensitive: false,
  link: "",
  field: "",
};

function draftOf(f: CustomFieldRow): Draft {
  return {
    id: f.id,
    label: f.label ?? f.key,
    type: f.type,
    choices: f.options.choices ?? [],
    originals: (f.options.choices ?? []).map((c) => c.value),
    target: f.options.target ?? "persons",
    multiple: f.options.multiple !== false,
    formula: f.options.formula ?? "",
    decimals: f.options.decimals === undefined ? "" : String(f.options.decimals),
    sensitive: f.options.sensitive === true,
    link: f.options.link ?? "",
    field: f.options.field ?? "",
  };
}

function optionsOf(d: Draft): CustomFieldOptions {
  switch (d.type) {
    case "select":
    case "multiselect":
      return {
        choices: d.choices
          .map((c) => ({ value: c.value.trim(), color: c.color }))
          .filter((c) => c.value),
      };
    case "link":
      return { target: d.target, ...(d.multiple ? {} : { multiple: false }) };
    case "formula":
      return { formula: d.formula };
    case "lookup":
      return { link: d.link, field: d.field };
    case "number":
      return d.decimals.trim() === "" ? {} : { decimals: Number(d.decimals) };
    case "text":
    case "longtext":
      return d.sensitive ? { sensitive: true } : {};
    default:
      return {};
  }
}

export function FieldsManager({ fieldTable, canEdit }: { fieldTable: string; canEdit: boolean }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const fields = useShowStore((s) => fieldsFor(s.tables.custom_fields, fieldTable));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the form closes (saved or cancelled), focus goes back to "+ Add field" (it stays in
  // the popover, so Escape still closes it).
  const addButton = useRef<HTMLButtonElement>(null);
  const hadDraft = useRef(false);
  useEffect(() => {
    if (hadDraft.current && !draft) addButton.current?.focus();
    hadDraft.current = !!draft;
  }, [draft]);

  const countOf = (f: CustomFieldRow) => {
    const data = store.getState();
    if (f.type === "attachment") {
      const ids = new Set<string>();
      for (const a of data.tables.attachments.values()) if (a.field === f.key) ids.add(a.record_id);
      return ids.size;
    }
    return valueCount(data, fieldTable, f.key);
  };

  const remove = (f: CustomFieldRow) => {
    const n = countOf(f);
    const label = f.label || f.key;
    const msg =
      n > 0
        ? `Delete the field "${label}"? ${n} ${n === 1 ? "row has a value" : "rows have values"} that will be deleted.`
        : `Delete the field "${label}"?`;
    if (!window.confirm(msg)) return;
    store
      .mutate([{ op: "delete", table: "custom_fields", id: f.id }])
      .catch((e: unknown) => ws.reportError(e, "delete the field"));
  };

  const save = () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) {
      setError("Give the field a name.");
      return;
    }
    if (draft.type === "formula") {
      const c = compileCached(draft.formula);
      if (!draft.formula.trim() || isFormulaError(c)) {
        setError(isFormulaError(c) ? c.error : "Write a formula.");
        return;
      }
    }
    if (draft.type === "lookup" && (!draft.link || !draft.field)) {
      setError("Pick a link field and the field to show.");
      return;
    }
    if (draft.type === "number" && draft.decimals.trim() !== "") {
      const n = Number(draft.decimals);
      if (!Number.isInteger(n) || n < 0 || n > 8) {
        setError("Decimals must be a whole number from 0 to 8.");
        return;
      }
    }
    const options = optionsOf(draft);
    const data = store.getState();
    const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
    if (draft.id) {
      const before = data.tables.custom_fields.get(draft.id);
      if (!before) return;
      // Renamed choices keep their rows (the server rewrites values and view filters).
      const isSelect = draft.type === "select" || draft.type === "multiselect";
      const renames = isSelect
        ? draft.choices.flatMap((c, i) => {
            const from = draft.originals[i];
            const to = c.value.trim();
            return from && to && from !== to ? [{ from, to }] : [];
          })
        : [];
      const warnings: string[] = [];
      if (before.type !== draft.type && !keepsValues(before.type, draft.type)) {
        const n = countOf(before);
        if (n > 0) warnings.push(`Changing the type clears the values in ${rows(n)}.`);
      } else if (isSelect && before.type === draft.type) {
        const kept = new Set(draft.originals.filter((o): o is string => !!o));
        const removed = (before.options.choices ?? [])
          .map((c) => c.value)
          .filter((v) => !kept.has(v));
        const n = choiceUseCount(data, fieldTable, before.key, removed);
        if (n > 0) {
          warnings.push(
            `Removing ${removed.map((v) => `"${v}"`).join(", ")} clears it from ${rows(n)}.`,
          );
        }
      } else if (draft.type === "link" && before.type === "link") {
        if ((before.options.target ?? "") !== draft.target) {
          const n = countOf(before);
          if (n > 0) warnings.push(`Linking to another table clears the links in ${rows(n)}.`);
        } else if (before.options.multiple !== false && !draft.multiple) {
          const n = manyLinksCount(data, fieldTable, before.key);
          if (n > 0) warnings.push(`${rows(n)} link more than one record; only the first stays.`);
        }
      }
      if (warnings.length && !window.confirm(`${warnings.join(" ")} Continue?`)) return;
      store
        .mutate([
          {
            op: "update",
            table: "custom_fields",
            id: draft.id,
            fields: {
              label,
              type: draft.type,
              options,
              ...(renames.length ? { renames } : {}),
            },
          },
        ])
        .catch((e: unknown) => ws.reportError(e, "save the field"));
    } else {
      const { ops, key } = newFieldOps(data, fieldTable, {
        label,
        type: draft.type,
        options: options as Record<string, unknown>,
      });
      // Rows may already hold values under this key (imported, free-form): the ones that
      // don't fit the new field are cleared.
      const n = valueCount(data, fieldTable, key);
      if (
        n > 0 &&
        !window.confirm(
          `${rows(n)} already ${n === 1 ? "has a value" : "have values"} under "${key}"; values that don't fit a ${CUSTOM_FIELD_TYPE_LABELS[draft.type].toLowerCase()} field are cleared. Continue?`,
        )
      ) {
        return;
      }
      store.mutate(ops).catch((e: unknown) => ws.reportError(e, "add the field"));
    }
    setDraft(null);
    setError(null);
  };

  return (
    <section className={styles.stack} aria-label="Custom fields" data-testid="fields-manager">
      <h4 className={styles.sectionTitle}>Custom fields</h4>
      {fields.length === 0 && !draft && <p className={styles.muted}>None yet.</p>}
      {fields.length > 0 && (
        <ul className={styles.fieldList}>
          {fields.map((f) => (
            <li key={f.id} className={styles.fieldItem} data-testid="custom-field">
              <span className={styles.customFieldName}>
                {f.label || f.key}{" "}
                <span className={styles.muted}>
                  · {CUSTOM_FIELD_TYPE_LABELS[f.type]}
                  {f.type === "link" && f.options.target
                    ? ` → ${targetTableLabel(store.getState(), f.options.target)}`
                    : ""}
                  {f.type === "lookup" ? ` · ${lookupSummary(store.getState(), f)}` : ""}
                  {f.options.sensitive ? " · sensitive" : ""}
                </span>
              </span>
              {canEdit && (
                <span className={styles.moveButtons}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    aria-label={`Edit field ${f.label || f.key}`}
                    onClick={() => {
                      setError(null);
                      setDraft(draftOf(f));
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    data-destructive
                    aria-label={`Delete field ${f.label || f.key}`}
                    onClick={() => remove(f)}
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && !draft && (
        <button
          type="button"
          ref={addButton}
          className={styles.linkButton}
          onClick={() => {
            setError(null);
            setDraft({ id: null, ...EMPTY });
          }}
        >
          + Add field
        </button>
      )}
      {canEdit && draft && (
        <FieldForm
          fieldTable={fieldTable}
          draft={draft}
          onChange={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          error={error}
        />
      )}
    </section>
  );
}

function FieldForm({
  fieldTable,
  draft,
  onChange,
  onSave,
  onCancel,
  error,
}: {
  fieldTable: string;
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  const id = useId();
  const customTables = useShowStore((s) => s.tables.custom_tables);
  const targets = useMemo(() => linkTargets(customTables), [customTables]);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  // Lookups: this table's link fields, and the fields of the table the chosen one links to.
  const store = useShowStoreInstance();
  const customFields = useShowStore((s) => s.tables.custom_fields);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lists change with the field definitions
  const lookupLinks = useMemo(
    () => lookupLinkColumns(store.getState(), fieldTable),
    [store, fieldTable, customFields, customTables],
  );
  const lookupTarget = lookupLinks.find((l) => l.key === draft.link)?.target ?? null;
  const ownKey = draft.id ? customFields.get(draft.id)?.key : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list changes with the field definitions
  const lookupFields = useMemo(
    () =>
      lookupTarget
        ? lookupFieldColumns(store.getState(), lookupTarget).filter(
            // A field can't show itself.
            (c) => !(lookupTarget === fieldTable && ownKey && c.key === `custom.${ownKey}`),
          )
        : [],
    [store, lookupTarget, fieldTable, ownKey, customFields, customTables],
  );
  const firstFieldOf = (link: string) => {
    const target = lookupLinks.find((l) => l.key === link)?.target;
    return target ? (lookupFieldColumns(store.getState(), target)[0]?.key ?? "") : "";
  };
  const formulaError = (() => {
    if (draft.type !== "formula" || !draft.formula.trim()) return null;
    const c = compileCached(draft.formula);
    return isFormulaError(c) ? c.error : null;
  })();
  return (
    <form
      className={styles.nameForm}
      aria-label={draft.id ? "Edit field" : "New field"}
      data-testid="field-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label className={styles.field}>
        <span>Field name</span>
        <input
          className={styles.input}
          value={draft.label}
          maxLength={200}
          data-autofocus
          // biome-ignore lint/a11y/noAutofocus: the form appears on request
          autoFocus
          onChange={(e) => set({ label: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>Type</span>
        <select
          className={styles.input}
          value={draft.type}
          onChange={(e) => {
            const type = e.target.value as CustomFieldType;
            // A new lookup starts on the first link field and its first field.
            const link =
              type === "lookup" && !draft.link ? (lookupLinks[0]?.key ?? "") : draft.link;
            set({
              type,
              link,
              field: link !== draft.link ? firstFieldOf(link) : draft.field,
            });
          }}
        >
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {CUSTOM_FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {(draft.type === "select" || draft.type === "multiselect") && (
        <fieldset className={styles.optionEditor}>
          <legend className={styles.sectionTitle}>Options</legend>
          {draft.choices.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: options are edited in place by position
            <div key={i} className={styles.row}>
              <input
                className={styles.input}
                aria-label={`Option ${i + 1}`}
                value={c.value}
                maxLength={200}
                onChange={(e) =>
                  set({
                    choices: draft.choices.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  })
                }
              />
              <select
                className={styles.input}
                aria-label={`Option ${i + 1} color`}
                value={c.color}
                onChange={(e) =>
                  set({
                    choices: draft.choices.map((x, j) =>
                      j === i ? { ...x, color: e.target.value } : x,
                    ),
                  })
                }
              >
                {OPTION_COLORS.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.iconButton}
                data-destructive
                aria-label={`Remove option ${i + 1}`}
                onClick={() =>
                  set({
                    choices: draft.choices.filter((_, j) => j !== i),
                    originals: draft.originals.filter((_, j) => j !== i),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() =>
              set({
                choices: [
                  ...draft.choices,
                  {
                    value: "",
                    color: OPTION_COLORS[
                      (draft.choices.length + 6) % OPTION_COLORS.length
                    ] as string,
                  },
                ],
                originals: [...draft.originals, null],
              })
            }
          >
            + Add option
          </button>
        </fieldset>
      )}
      {draft.type === "link" && (
        <>
          <label className={styles.field}>
            <span>Links to</span>
            <select
              className={styles.input}
              value={draft.target}
              onChange={(e) => set({ target: e.target.value })}
            >
              {targets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.multiple}
              onChange={(e) => set({ multiple: e.target.checked })}
            />
            Allow more than one record
          </label>
        </>
      )}
      {draft.type === "formula" && (
        <div className={styles.field}>
          <label htmlFor={`${id}-formula`}>Formula</label>
          <textarea
            id={`${id}-formula`}
            className={styles.input}
            rows={3}
            value={draft.formula}
            aria-describedby={`${id}-help`}
            aria-invalid={formulaError ? true : undefined}
            placeholder="{PPI} * 2"
            onChange={(e) => set({ formula: e.target.value })}
          />
          <span
            id={`${id}-help`}
            className={styles.muted}
            role={formulaError ? "alert" : undefined}
          >
            {formulaError ??
              'Name fields in braces: {Width} / 2, IF({Status} = "Done", 1, 0), {Venue}.Name'}
          </span>
        </div>
      )}
      {draft.type === "lookup" &&
        (lookupLinks.length === 0 ? (
          <p className={styles.muted}>
            This table has no link fields yet. Add a link field first, then look up its records'
            fields.
          </p>
        ) : (
          <>
            <label className={styles.field}>
              <span>Link field</span>
              <select
                className={styles.input}
                value={draft.link}
                onChange={(e) => set({ link: e.target.value, field: firstFieldOf(e.target.value) })}
              >
                {!lookupLinks.some((l) => l.key === draft.link) && (
                  <option value={draft.link}>
                    {draft.link ? `${draft.link} (gone)` : "Pick one"}
                  </option>
                )}
                {lookupLinks.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.title} → {targetTableLabel(store.getState(), l.target)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Field to show</span>
              <select
                className={styles.input}
                value={draft.field}
                onChange={(e) => set({ field: e.target.value })}
              >
                {!lookupFields.some((c) => c.key === draft.field) && (
                  <option value={draft.field}>
                    {draft.field ? `${draft.field} (gone)` : "Pick one"}
                  </option>
                )}
                {lookupFields.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </>
        ))}
      {draft.type === "number" && (
        <label className={styles.inline}>
          <span>Decimals</span>
          <input
            className={styles.input}
            style={{ width: "4.5em" }}
            inputMode="numeric"
            value={draft.decimals}
            placeholder="auto"
            onChange={(e) => set({ decimals: e.target.value })}
          />
        </label>
      )}
      {(draft.type === "text" || draft.type === "longtext") && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.sensitive}
            onChange={(e) => set({ sensitive: e.target.checked })}
          />
          Sensitive (masked; kept out of history and exports)
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        <button type="submit" className={styles.primary}>
          {draft.id ? "Save field" : "Add field"}
        </button>
        <button type="button" className={styles.toolButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Rows whose value uses any of `values` (a select's removed choices). */
function choiceUseCount(
  data: Parameters<typeof valueCount>[0],
  fieldTable: string,
  key: string,
  values: readonly string[],
): number {
  if (values.length === 0) return 0;
  const set = new Set(values);
  return customRowsOf(data, fieldTable).filter((c) => {
    const v = c[key];
    return typeof v === "string"
      ? set.has(v)
      : Array.isArray(v) && v.some((x) => set.has(x as string));
  }).length;
}

/** Rows linking more than one record through `key`. */
function manyLinksCount(data: Parameters<typeof valueCount>[0], fieldTable: string, key: string) {
  return customRowsOf(data, fieldTable).filter(
    (c) => Array.isArray(c[key]) && (c[key] as unknown[]).length > 1,
  ).length;
}
