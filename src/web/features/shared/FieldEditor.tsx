// One field in the row panel's Fields tab (R18), edited in place with the same value shapes
// and pickers as the grid: text/number inputs, long text, checkbox, and select / multiselect
// / link / multilink through `RecordPicker`. Commits go to `onCommit(value)` (the table's
// edit ops); a draft being typed survives remote changes to the same field.
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Chip, type CloseReason, type PickerItem, RecordPicker } from "../../components/grid";
import { optionColor } from "../../components/grid/Chip";
import { CellContent } from "../../components/grid/cells";
import type { Column } from "../../components/grid/types";
import { formatValue, NOT_PARSED } from "../../components/grid/values";
import { editorText, isFieldEditable, panelCommit, valueFromText } from "./panelFields";
import styles from "./RowPanel.module.css";

export function FieldEditor<Row>({
  col,
  row,
  canEdit,
  onCommit,
}: {
  col: Column<Row>;
  row: Row;
  /** False: show the value only (no permission, or no edit handler). */
  canEdit: boolean;
  onCommit: (value: unknown) => void;
}) {
  const editable = canEdit && isFieldEditable(col, row);
  const value = col.getValue(row);
  const commit = (next: unknown) => {
    const v = panelCommit(col, row, next);
    if (v !== undefined) onCommit(v);
  };

  if (!editable) return <ReadValue col={col} value={value} />;
  switch (col.type) {
    case "text":
    case "number":
    case "longtext":
    case "measurement":
    case "pixelsize":
      return <TextField col={col} value={value} onCommit={commit} />;
    case "checkbox":
      return (
        <input
          type="checkbox"
          className={styles.checkbox}
          aria-label={col.title}
          checked={!!value}
          onChange={(e) => commit(e.target.checked)}
        />
      );
    case "select":
    case "multiselect":
    case "link":
    case "multilink":
      return <PickerField col={col} row={row} value={value} onCommit={commit} />;
    default:
      return <ReadValue col={col} value={value} />;
  }
}

function ReadValue<Row>({ col, value }: { col: Column<Row>; value: unknown }) {
  if (col.type === "formula" || col.type === "measurement") {
    // Error styling and unit labels as in the grid.
    if (value === null || value === undefined || value === "") return <Empty />;
    return (
      <span className={styles.value}>
        <CellContent col={col} value={value} editable={false} onToggle={() => {}} />
      </span>
    );
  }
  const chips = chipsOf(col, value);
  if (chips) return chips.length ? <span className={styles.chips}>{chips}</span> : <Empty />;
  const text = formatValue(col, value);
  return text ? (
    <span className={col.type === "readonly" ? styles.readonly : styles.value}>{text}</span>
  ) : (
    <Empty />
  );
}

const Empty = () => <span className={styles.empty}>—</span>;

function chipsOf<Row>(col: Column<Row>, value: unknown, onRemove?: (v: unknown) => void) {
  if (col.type === "select" || col.type === "multiselect") {
    const values = (Array.isArray(value) ? value : value ? [value] : []) as string[];
    return values.map((v) => {
      const o = col.options?.find((x) => x.value === v);
      const label = o?.label ?? v;
      return (
        <Chip
          key={v}
          label={label}
          color={o?.color ?? "gray"}
          {...(onRemove ? { onRemove: () => onRemove(v), removeLabel: `Remove ${label}` } : {})}
        />
      );
    });
  }
  if (col.type === "link" || col.type === "multilink") {
    const items = (Array.isArray(value) ? value : value ? [value] : []) as PickerItem[];
    return items.map((it) => (
      <Chip
        key={it.id}
        label={it.label}
        color={it.color}
        {...(onRemove ? { onRemove: () => onRemove(it), removeLabel: `Remove ${it.label}` } : {})}
      />
    ));
  }
  return null;
}

/** Text, number and long text: a draft while focused; Enter or blur commits, Escape reverts. */
function TextField<Row>({
  col,
  value,
  onCommit,
}: {
  col: Column<Row>;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const multiline = col.type === "longtext";
  const shown = draft ?? editorText(col, value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!multiline || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  });

  // Escape reverts: the blur that follows mustn't commit the abandoned draft.
  const reverted = useRef(false);
  const finish = () => {
    if (reverted.current) {
      reverted.current = false;
      return;
    }
    if (draft === null) return;
    const v = valueFromText(col, draft);
    if (v === NOT_PARSED) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    onCommit(v);
  };
  const common = {
    ref,
    "aria-label": col.title,
    "aria-invalid": invalid || undefined,
    className: multiline ? styles.textarea : styles.input,
    value: shown,
    onFocus: () => {
      reverted.current = false;
      setDraft(editorText(col, value));
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: finish,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !(multiline && (e.shiftKey || e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        finish();
      } else if (e.key === "Escape") {
        // Revert and leave the field; the next Escape closes the panel.
        e.preventDefault();
        e.stopPropagation();
        reverted.current = true;
        setDraft(null);
        setInvalid(false);
        e.currentTarget.closest<HTMLElement>("[data-testid='row-panel']")?.focus();
      }
    },
  };
  return multiline ? (
    <textarea rows={1} {...common} />
  ) : (
    <input
      type="text"
      inputMode={col.type === "number" ? "decimal" : undefined}
      placeholder={
        col.type === "measurement"
          ? `e.g. 4.5 m, 14' 9"`
          : col.type === "pixelsize"
            ? "e.g. 1920x1080"
            : undefined
      }
      {...common}
    />
  );
}

/** Select / multiselect / link / multilink: chips, and a RecordPicker to change them. */
function PickerField<Row>({
  col,
  row,
  value,
  onCommit,
}: {
  col: Column<Row>;
  row: Row;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const isOptions = col.type === "select" || col.type === "multiselect";
  const multi = col.type === "multiselect" || col.type === "multilink";
  const list = (Array.isArray(value) ? value : value ? [value] : []) as unknown[];
  const idOf = (x: unknown) => (typeof x === "string" ? x : (x as PickerItem).id);

  const search = useMemo(() => {
    if (!isOptions) {
      const find = col.search;
      return find ? (q: string) => find(q, row) : () => [];
    }
    const items: PickerItem[] = (col.options ?? []).map((o) => ({
      id: o.value,
      label: o.label ?? o.value,
      color: optionColor(o.color),
    }));
    return (q: string) => {
      const t = q.trim().toLowerCase();
      return t ? items.filter((i) => i.label.toLowerCase().includes(t)) : items;
    };
  }, [isOptions, col.options, col.search, row]);
  const create = useMemo(() => {
    const make = col.create;
    return make && !isOptions ? (name: string) => make(name, row) : undefined;
  }, [isOptions, col.create, row]);

  const remove = (x: unknown) => {
    const id = idOf(x);
    onCommit(multi ? list.filter((y) => idOf(y) !== id) : null);
  };
  const pick = (item: PickerItem) => {
    const v = isOptions ? item.id : item;
    if (!multi) {
      onCommit(v);
      setOpen(false);
      button.current?.focus();
      return;
    }
    const has = list.some((y) => idOf(y) === item.id);
    onCommit(has ? list.filter((y) => idOf(y) !== item.id) : [...list, v]);
  };
  const close = (_reason: CloseReason) => {
    setOpen(false);
    button.current?.focus();
  };

  const chips = chipsOf(col, value, remove) as ReactNode[];
  return (
    <span className={styles.pickerField}>
      {chips.length > 0 && <span className={styles.chips}>{chips}</span>}
      <button
        type="button"
        ref={button}
        className={styles.pickButton}
        aria-label={`${chips.length ? "Change" : "Set"} ${col.title}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {chips.length ? (multi ? "+" : "✎") : "+ Set"}
      </button>
      {open && (
        <RecordPicker
          anchor={button.current}
          search={search}
          create={create}
          selectedIds={list.map(idOf)}
          multi={multi}
          debounceMs={isOptions ? 0 : 100}
          label={`${col.title}: search`}
          placeholder={isOptions ? "Find an option…" : create ? "Find or create…" : "Find…"}
          onPick={pick}
          onClose={close}
          {...(multi && list.length
            ? { onBackspaceEmpty: () => remove(list[list.length - 1]) }
            : {})}
        />
      )}
    </span>
  );
}
