// The active measurement unit (R11, ux.md §Measurements): the view's override, else your
// preference (this browser), else the show's default, else meters. `withUnit` hands it to
// the measurement (and length-formula) columns; `UnitToggle` is the toolbar's m / cm /
// ft-in switch, which sets the view's override.
import { useCallback, useSyncExternalStore } from "react";
import { FALLBACK_UNIT, isUnit, TOGGLE_UNITS, UNIT_LABELS, type Unit } from "../../../shared/units";
import type { Column } from "../../components/grid/types";
import { readPref, writePref } from "../shared/prefs";
import styles from "./ViewBar.module.css";

export const userUnitKey = (userId: string) => `cuesheet.unit.${userId}`;

const UNIT_EVENT = "cuesheet:unit";
const isUnitOrNull = (v: unknown): v is Unit | null => v === null || isUnit(v);

/** Your preferred unit in this browser (null: follow the show). Live across tabs/grids. */
export function useUserUnit(userId: string): Unit | null {
  const key = userUnitKey(userId);
  const subscribe = useCallback(
    (cb: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) cb();
      };
      window.addEventListener(UNIT_EVENT, cb);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener(UNIT_EVENT, cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );
  return useSyncExternalStore(
    subscribe,
    () => readPref(key, null, isUnitOrNull),
    () => null,
  );
}

export function setUserUnit(userId: string, unit: Unit | null): void {
  writePref(userUnitKey(userId), unit ?? undefined);
  window.dispatchEvent(new Event(UNIT_EVENT));
}

/** View override → user preference → show default → meters. */
export function resolveUnit(
  viewUnit: Unit | undefined | null,
  userUnit: Unit | null,
  showUnit: Unit | null,
): Unit {
  return viewUnit ?? userUnit ?? showUnit ?? FALLBACK_UNIT;
}

const usesUnit = (c: { type: string; resultType?: string }) =>
  c.type === "measurement" || (c.type === "formula" && c.resultType === "measurement");

/** Does a table show lengths (so the unit toggle belongs in its toolbar)? */
export function hasMeasurements(columns: readonly Column<never>[] | readonly Column<unknown>[]) {
  return (columns as readonly Column<unknown>[]).some(usesUnit);
}

/** Columns with `unit` set on those that show lengths (the same array if none do). */
export function withUnit<C extends { type: string; resultType?: string; unit?: Unit }>(
  columns: readonly C[],
  unit: Unit,
): C[] {
  if (!columns.some((c) => usesUnit(c) && c.unit !== unit)) return columns as C[];
  return columns.map((c) => (usesUnit(c) && c.unit !== unit ? { ...c, unit } : c));
}

/** The same for a field map (filters and color rules parse values in the active unit). */
export function withUnitFields<C extends { type: string; resultType?: string; unit?: Unit }>(
  fields: ReadonlyMap<string, C>,
  unit: Unit,
): Map<string, C> {
  const entries = [...fields];
  if (!entries.some(([, c]) => usesUnit(c) && c.unit !== unit)) return fields as Map<string, C>;
  return new Map(entries.map(([k, c]) => [k, usesUnit(c) && c.unit !== unit ? { ...c, unit } : c]));
}

/** m / cm / ft-in: sets the view's unit (every unit is still accepted when typing). */
export function UnitToggle({ unit, onChange }: { unit: Unit; onChange: (unit: Unit) => void }) {
  const shown = TOGGLE_UNITS.includes(unit) ? TOGGLE_UNITS : [...TOGGLE_UNITS, unit];
  return (
    <fieldset className={styles.unitToggle} data-testid="unit-toggle">
      <legend className={styles.unitLegend}>Units</legend>
      {shown.map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={u === unit}
          title={UNIT_LABELS[u]}
          className={styles.unitOption}
          onClick={() => onChange(u)}
        >
          {u}
        </button>
      ))}
    </fieldset>
  );
}
