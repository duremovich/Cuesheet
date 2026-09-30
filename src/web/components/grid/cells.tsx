// Cell display and the inline text editor.

import { useLayoutEffect, useRef } from "react";
import { isFormulaError, isQuantity, type Value } from "../../../shared/formula";
import { formatLengthParts } from "../../../shared/units";
import { Chip } from "./Chip";
import styles from "./DataGrid.module.css";
import type { Column, PickerItem } from "./types";
import { formatValue } from "./values";

export function CellContent<Row>({
  col,
  value,
  editable,
  onToggle,
}: {
  col: Column<Row>;
  value: unknown;
  editable: boolean;
  onToggle: () => void;
}) {
  switch (col.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          className={styles.checkbox}
          tabIndex={-1}
          checked={!!value}
          disabled={!editable}
          aria-label={col.title}
          onChange={onToggle}
        />
      );
    case "select": {
      if (value === null || value === undefined || value === "") return null;
      const o = col.options?.find((x) => x.value === value);
      return (
        <span className={styles.chips}>
          <Chip label={o?.label ?? String(value)} color={o?.color ?? "gray"} />
        </span>
      );
    }
    case "multiselect": {
      const vals = Array.isArray(value) ? (value as string[]) : [];
      return (
        <span className={styles.chips}>
          {vals.map((v) => {
            const o = col.options?.find((x) => x.value === v);
            return <Chip key={v} label={o?.label ?? v} color={o?.color ?? "gray"} />;
          })}
        </span>
      );
    }
    case "link":
    case "multilink": {
      const items = (Array.isArray(value) ? value : value ? [value] : []) as PickerItem[];
      return (
        <span className={styles.chips}>
          {items.map((it) => (
            <Chip key={it.id} label={it.label} color={it.color} />
          ))}
        </span>
      );
    }
    case "number":
    case "pixelsize":
      return <span className={styles.number}>{formatValue(col, value)}</span>;
    case "measurement": {
      if (typeof value !== "number") return null;
      const { value: text, label } = formatLengthParts(value, col.unit ?? "m");
      return (
        <span className={styles.number}>
          {text}
          {label && <span className={styles.unitLabel}> {label}</span>}
        </span>
      );
    }
    case "formula": {
      const v = value as Value;
      if (isFormulaError(v)) {
        return (
          <span className={styles.formulaError} title={v.error} data-formula-error={v.code}>
            {v.code}
            <span className={styles.visuallyHidden}>: {v.error}</span>
          </span>
        );
      }
      const numeric = typeof v === "number" || isQuantity(v);
      return (
        <span className={numeric ? styles.number : styles.readonly}>{formatValue(col, value)}</span>
      );
    }
    case "longtext":
      return <span className={styles.longtext}>{formatValue(col, value)}</span>;
    case "readonly":
      return <span className={styles.readonly}>{formatValue(col, value)}</span>;
    default:
      return <span className={styles.text}>{formatValue(col, value)}</span>;
  }
}

export function TextEditor({
  multiline,
  numeric,
  value,
  label,
  placeholder,
  invalid,
  onChange,
}: {
  multiline: boolean;
  numeric: boolean;
  value: string;
  label: string;
  /** Ghost suggestion (Tab / → accepts it). */
  placeholder?: string | undefined;
  /** Why the text was refused (aria-invalid + tooltip); the editor stays open. */
  invalid?: string | undefined;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!multiline || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 280)}px`;
  });

  if (multiline) {
    return (
      <textarea
        ref={ref}
        className={styles.editorArea}
        aria-label={label}
        data-editor="true"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // ⌘/Ctrl+Enter: newline (plain Enter commits, handled by the grid).
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            const el = e.currentTarget;
            el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
            onChange(el.value);
          } else if (e.key === "Enter" && e.shiftKey && !(e.metaKey || e.ctrlKey)) {
            e.stopPropagation(); // Shift+Enter: native newline
          }
        }}
      />
    );
  }
  return (
    <input
      ref={ref}
      type="text"
      inputMode={numeric ? "decimal" : undefined}
      className={styles.editor}
      aria-label={label}
      aria-invalid={invalid ? true : undefined}
      title={invalid}
      data-editor="true"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
