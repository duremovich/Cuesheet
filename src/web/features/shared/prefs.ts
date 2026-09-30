// Per-browser UI preferences in localStorage (column widths, collapsed groups, live sort).
// Saved views (M2) will replace most of this. Storage may be unavailable (private mode,
// blocked site data): reads fall back to the default and writes are best-effort.
import { useCallback, useEffect, useState } from "react";

export const prefKey = {
  widths: (showId: string, table: string) => `cuesheet.widths.${showId}.${table}`,
  collapsed: (userId: string, showId: string, table: string) =>
    `cuesheet.collapsed.${userId}.${showId}.${table}`,
  sort: (showId: string, table: string) => `cuesheet.sort.${showId}.${table}`,
};

export function readPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the preference lasts for this page only.
  }
}

/** useState backed by localStorage under `key` (re-read when the key changes). */
export function usePref<T>(
  key: string,
  fallback: T,
  valid: (v: unknown) => v is T,
): [T, (v: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({
    key,
    value: readPref(key, fallback, valid),
  }));
  // A new key (another show/table): load its value.
  useEffect(() => {
    if (state.key !== key) setState({ key, value: readPref(key, fallback, valid) });
  }, [key, state.key, fallback, valid]);
  const set = useCallback(
    (v: T) => {
      writePref(key, v);
      setState({ key, value: v });
    },
    [key],
  );
  return [state.key === key ? state.value : readPref(key, fallback, valid), set];
}

export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export const isWidthMap = (v: unknown): v is Record<string, number> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "number" && x > 0 && x < 5000);
