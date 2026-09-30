// One filter condition: field, operator and a value editor typed by the field (used by the
// Filter panel and by color rules).
import { useId, useMemo } from "react";
import { type Filter, type FilterOp, LIST_OPS, VALUELESS_OPS } from "../../../shared/views";
import { type FieldDef, fieldKind, linkItems, opLabel, opsFor } from "./evaluate";
import styles from "./ViewBar.module.css";

/** A fresh condition on `field`. */
export function newFilter<V>(field: FieldDef<V>): Filter {
  return { key: field.key, op: opsFor(field)[0] ?? "is" };
}

interface Choice {
  /** What the filter stores: an option value, or a linked record's id. */
  value: string;
  label: string;
}

/**
 * The choices a list/select value editor offers: a select's options, or the records the
 * rows link to (by id, labelled; plus ids the filter already holds, by their cached label).
 */
function useChoices<V>(
  field: FieldDef<V> | undefined,
  rows: readonly V[],
  cached: Record<string, string> | undefined,
): Choice[] {
  return useMemo(() => {
    if (!field) return [];
    if (field.options?.length) {
      return field.options.map((o) => ({ value: o.value, label: o.label ?? o.value }));
    }
    if (field.type !== "link" && field.type !== "multilink") return [];
    const seen = new Map<string, string>();
    for (const r of rows) for (const p of linkItems(field.getValue(r))) seen.set(p.id, p.label);
    for (const [id, l] of Object.entries(cached ?? {})) if (!seen.has(id)) seen.set(id, l);
    const collator = new Intl.Collator(undefined, { numeric: true });
    return [...seen]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => collator.compare(a.label, b.label))
      .slice(0, 500);
  }, [field, rows, cached]);
}

export function FilterEditor<V>({
  filter,
  fields,
  rows,
  onChange,
  onRemove,
  label,
}: {
  filter: Filter;
  /** Fields to pick from (columns + extras). */
  fields: readonly FieldDef<V>[];
  rows: readonly V[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
  /** "Filter 1", "Rule 2 condition 1": prefixes the controls' accessible names. */
  label: string;
}) {
  const field = fields.find((f) => f.key === filter.key);
  const ops = field ? opsFor(field) : [];
  const choices = useChoices(field, rows, filter.labels);
  const listId = useId();
  const kind = field ? fieldKind(field) : "text";

  const setField = (key: string) => {
    const f = fields.find((x) => x.key === key);
    if (!f) return;
    const allowed = opsFor(f);
    onChange({ key, op: allowed.includes(filter.op) ? filter.op : (allowed[0] ?? "is") });
  };
  const setOp = (op: FilterOp) => {
    const next: Filter = {
      key: filter.key,
      op,
      ...(filter.labels ? { labels: filter.labels } : {}),
    };
    // Keep a compatible value (a single value ↔ a list converts).
    if (!VALUELESS_OPS.has(op)) {
      const v = filter.value;
      if (LIST_OPS.has(op)) {
        if (Array.isArray(v)) next.value = v;
        else if (typeof v === "string" && v) next.value = [v];
      } else if (!Array.isArray(v) && v !== undefined) next.value = v;
      else if (Array.isArray(v) && typeof v[0] === "string") next.value = v[0];
    }
    onChange(next);
  };
  const isLink = kind === "link";
  /** Set the value; link filters also cache the picked records' labels. */
  const setValue = (value: unknown) => {
    if (!isLink || !(typeof value === "string" || Array.isArray(value))) {
      const { labels: _l, ...rest } = filter;
      onChange({ ...rest, value });
      return;
    }
    const ids = Array.isArray(value) ? (value as string[]) : [value];
    const labels: Record<string, string> = {};
    for (const id of ids) {
      const c = choices.find((x) => x.value === id);
      if (c) labels[id] = c.label;
    }
    onChange({ ...filter, value, labels });
  };

  let editor: React.ReactNode = null;
  if (field && !VALUELESS_OPS.has(filter.op)) {
    if (LIST_OPS.has(filter.op)) {
      const picked = new Set(Array.isArray(filter.value) ? (filter.value as string[]) : []);
      editor =
        choices.length > 0 ? (
          <fieldset className={styles.choiceList} aria-label={`${label} values`}>
            {choices.map((c) => (
              <label key={c.value} className={styles.check}>
                <input
                  type="checkbox"
                  checked={picked.has(c.value)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.value);
                    else next.delete(c.value);
                    setValue(choices.filter((x) => next.has(x.value)).map((x) => x.value));
                  }}
                />
                {c.label}
              </label>
            ))}
          </fieldset>
        ) : (
          <input
            className={styles.input}
            aria-label={`${label} values (comma-separated)`}
            value={Array.isArray(filter.value) ? (filter.value as string[]).join(", ") : ""}
            onChange={(e) =>
              setValue(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        );
    } else if (
      (kind === "select" || kind === "multi" || kind === "link") &&
      (filter.op === "is" || filter.op === "isNot")
    ) {
      editor = (
        <select
          className={styles.input}
          aria-label={`${label} value`}
          value={typeof filter.value === "string" ? filter.value : ""}
          onChange={(e) => setValue(e.target.value || undefined)}
        >
          <option value="">Choose…</option>
          {typeof filter.value === "string" &&
            filter.value &&
            !choices.some((c) => c.value === filter.value) && (
              <option value={filter.value}>{filter.value}</option>
            )}
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    } else if (kind === "date") {
      editor = (
        <input
          type="date"
          className={styles.input}
          aria-label={`${label} date`}
          value={typeof filter.value === "string" ? filter.value : ""}
          onChange={(e) => setValue(e.target.value || undefined)}
        />
      );
    } else if (kind === "number") {
      editor = (
        <input
          type="number"
          className={styles.input}
          aria-label={`${label} value`}
          value={typeof filter.value === "number" ? String(filter.value) : ""}
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            setValue(Number.isFinite(n) ? n : undefined);
          }}
        />
      );
    } else {
      editor = (
        <>
          <input
            className={styles.input}
            aria-label={`${label} value`}
            list={choices.length ? listId : undefined}
            value={typeof filter.value === "string" ? filter.value : ""}
            onChange={(e) => setValue(e.target.value)}
          />
          {choices.length > 0 && (
            <datalist id={listId}>
              {choices.map((c) => (
                <option key={c.value} value={c.label} />
              ))}
            </datalist>
          )}
        </>
      );
    }
  }

  return (
    <div className={styles.condition} data-testid="filter-row">
      <select
        className={styles.input}
        aria-label={`${label} field`}
        value={filter.key}
        onChange={(e) => setField(e.target.value)}
      >
        {!field && <option value={filter.key}>{filter.key} (missing)</option>}
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.title}
          </option>
        ))}
      </select>
      <select
        className={styles.input}
        aria-label={`${label} operator`}
        value={filter.op}
        onChange={(e) => setOp(e.target.value as FilterOp)}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opLabel(op, field)}
          </option>
        ))}
      </select>
      <div className={styles.valueSlot}>{editor}</div>
      <button
        type="button"
        className={styles.iconButton}
        data-destructive
        aria-label={`Remove ${label.toLocaleLowerCase()}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
