// The surface calculator (R12, S2): the Surfaces row panel's "Calculator" tab. Physical
// size, pixel size and PPI together; edit any one and another follows so the locked one
// stays (./calc.ts has the rules); aspect ratio, pixel pitch, the projector's throw and
// a region's share of its parent alongside. Every change is a real `update` op.
import { useId, useState } from "react";
import { aspectText } from "../../../shared/formula";
import type { SurfaceRow } from "../../../shared/tables";
import {
  editLength,
  formatLength,
  parseLength,
  TOGGLE_UNITS,
  UNIT_LABELS,
  type Unit,
} from "../../../shared/units";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace } from "../show/workspace";
import { setUserUnit } from "../views/units";
import styles from "./Calculator.module.css";
import {
  applyCalcEdit,
  type CalcField,
  type CalcState,
  defaultLock,
  distanceFor,
  imageWidth,
  type Lock,
  pitchOf,
  ppiOf,
  ratioFor,
  regionShare,
} from "./calc";

const stateOf = (s: SurfaceRow): CalcState => ({
  width: s.width,
  height: s.height,
  pixel_width: s.pixel_width,
  pixel_height: s.pixel_height,
});

const round = (n: number, d = 2) => String(Number(n.toFixed(d)));
const pct = (f: number) => `${Math.round(f * 100)}%`;

type Parse = (text: string) => number | null | "invalid";

/**
 * A text field showing `display` until focused, then `edit`; Enter or blur commits the
 * parsed value (only when the text changed), Escape reverts.
 */
function CalcInput({
  label,
  testId,
  display,
  edit,
  parse,
  disabled,
  onCommit,
  placeholder,
}: {
  label: string;
  testId: string;
  display: string;
  edit: string;
  parse: Parse;
  disabled: boolean;
  onCommit: (v: number | null) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    if (draft === null) return;
    if (draft.trim() === edit.trim()) {
      setDraft(null);
      return;
    }
    const v = parse(draft);
    if (v === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    onCommit(v);
  };
  return (
    <input
      type="text"
      className={styles.input}
      aria-label={label}
      aria-invalid={invalid || undefined}
      data-testid={testId}
      disabled={disabled}
      placeholder={placeholder}
      value={draft ?? display}
      onFocus={() => setDraft(edit)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
          setInvalid(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function LockButton({
  lock,
  value,
  what,
  onLock,
}: {
  lock: Lock;
  value: Lock;
  what: string;
  onLock: (l: Lock) => void;
}) {
  const on = lock === value;
  return (
    <button
      type="button"
      className={styles.lock}
      aria-pressed={on}
      aria-label={`Keep ${what} fixed`}
      title={on ? `${what} stays fixed` : `Keep ${what} fixed`}
      onClick={() => onLock(value)}
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path
          d={
            on
              ? "M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z"
              : "M4.5 7V5a3.5 3.5 0 0 1 6.8-1.2M3.5 7h9v6.5h-9z"
          }
        />
      </svg>
    </button>
  );
}

export function SurfaceCalculator({
  surfaceId,
  unit: initialUnit,
}: {
  surfaceId: string;
  unit: Unit;
}) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const surface = useShowStore((s) => s.tables.surfaces.get(surfaceId));
  const parent = useShowStore((s) =>
    surface?.parent_id ? s.tables.surfaces.get(surface.parent_id) : undefined,
  );
  const [unit, setUnit] = useState<Unit>(initialUnit);
  const [lockBy, setLockBy] = useState<{ id: string; lock: Lock } | null>(null);
  const [aspect, setAspect] = useState(false);
  const aspectId = useId();
  if (!surface) return null;
  const s = stateOf(surface);
  const lock = lockBy?.id === surfaceId ? lockBy.lock : defaultLock(parent && stateOf(parent));
  const disabled = !ws.canEdit;

  const write = (fields: Partial<SurfaceRow>) => {
    if (Object.keys(fields).length === 0) return;
    store
      .mutate([{ op: "update", table: "surfaces", id: surfaceId, fields }])
      .catch((e: unknown) => ws.reportError(e, "update the surface"));
  };
  const edit = (field: CalcField) => (v: number | null) =>
    write(applyCalcEdit(s, field, v, lock, aspect));

  const lengthParse: Parse = (t) => {
    const r = parseLength(t, unit);
    if (r === null) return null;
    return "m" in r ? r.m : "invalid";
  };
  const pixelParse: Parse = (t) => {
    const x = t.trim().replace(/px$/i, "").trim();
    if (!x) return null;
    const n = Number(x.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : "invalid";
  };
  const numberParse: Parse = (t) => {
    const x = t.trim();
    if (!x) return null;
    const n = Number(x.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : "invalid";
  };
  const lenText = (m: number | null) => (m === null ? "" : formatLength(m, unit));
  const lenEdit = (m: number | null) => (m === null ? "" : editLength(m, unit));
  const numText = (n: number | null) => (n === null ? "" : String(n));

  const ppi = ppiOf(s);
  const pitch = pitchOf(s);
  const pixelAspect =
    s.pixel_width && s.pixel_height ? aspectText(s.pixel_width, s.pixel_height) : null;
  const physicalAspect = s.width && s.height ? aspectText(s.width, s.height) : null;
  const img = imageWidth(surface.throw_distance, surface.lens_ratio);
  const needDistance = distanceFor(surface.width, surface.lens_ratio);
  const needRatio = ratioFor(surface.throw_distance, surface.width);
  const share = parent ? regionShare(s, stateOf(parent)) : null;

  return (
    <div className={styles.calc} data-testid="surface-calculator">
      <fieldset className={styles.units}>
        <legend className={styles.legend}>Units</legend>
        {(TOGGLE_UNITS.includes(unit) ? TOGGLE_UNITS : [...TOGGLE_UNITS, unit]).map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={u === unit}
            title={UNIT_LABELS[u]}
            className={styles.unit}
            onClick={() => {
              setUnit(u);
              setUserUnit(ws.userId, u);
            }}
          >
            {u}
          </button>
        ))}
      </fieldset>

      <section className={styles.block} aria-label="Size">
        <div className={styles.row}>
          <span className={styles.label}>Physical size</span>
          <CalcInput
            label="Physical width"
            testId="calc-width"
            display={lenText(s.width)}
            edit={lenEdit(s.width)}
            parse={lengthParse}
            disabled={disabled}
            onCommit={edit("width")}
          />
          <span className={styles.times} aria-hidden="true">
            ×
          </span>
          <CalcInput
            label="Physical height"
            testId="calc-height"
            display={lenText(s.height)}
            edit={lenEdit(s.height)}
            parse={lengthParse}
            disabled={disabled}
            onCommit={edit("height")}
          />
          <LockButton
            lock={lock}
            value="physical"
            what="the physical size"
            onLock={(l) => setLockBy({ id: surfaceId, lock: l })}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Pixels</span>
          <CalcInput
            label="Pixel width"
            testId="calc-pixel-width"
            display={numText(s.pixel_width)}
            edit={numText(s.pixel_width)}
            parse={pixelParse}
            disabled={disabled}
            onCommit={edit("pixel_width")}
          />
          <span className={styles.times} aria-hidden="true">
            ×
          </span>
          <CalcInput
            label="Pixel height"
            testId="calc-pixel-height"
            display={numText(s.pixel_height)}
            edit={numText(s.pixel_height)}
            parse={pixelParse}
            disabled={disabled}
            onCommit={edit("pixel_height")}
          />
          <LockButton
            lock={lock}
            value="pixels"
            what="the pixel size"
            onLock={(l) => setLockBy({ id: surfaceId, lock: l })}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>PPI</span>
          <CalcInput
            label="Pixels per inch"
            testId="calc-ppi"
            display={ppi === null ? "" : round(ppi)}
            edit={ppi === null ? "" : round(ppi, 4)}
            parse={numberParse}
            disabled={disabled}
            onCommit={edit("ppi")}
          />
          <span className={styles.times} />
          <span className={styles.muted}>{pitch === null ? "" : `${round(pitch)} mm pitch`}</span>
          <LockButton
            lock={lock}
            value="ppi"
            what="the PPI"
            onLock={(l) => setLockBy({ id: surfaceId, lock: l })}
          />
        </div>
        <label className={styles.check} htmlFor={aspectId}>
          <input
            id={aspectId}
            type="checkbox"
            checked={aspect}
            onChange={(e) => setAspect(e.target.checked)}
          />
          Keep aspect ratio (height follows width)
        </label>
        <dl className={styles.facts}>
          <div>
            <dt>Aspect</dt>
            <dd data-testid="calc-aspect">
              {pixelAspect ?? physicalAspect ?? "—"}
              {pixelAspect && physicalAspect && pixelAspect !== physicalAspect && (
                <span className={styles.warn}>
                  {" "}
                  (physical {physicalAspect}: pixels aren't square)
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {s.width !== null && s.height !== null
                ? `${formatLength(s.width, "m")} × ${formatLength(s.height, "m")} · ${formatLength(s.width, "ft-in")} × ${formatLength(s.height, "ft-in")}`
                : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.block} aria-label="Projector">
        <h3 className={styles.heading}>Projector</h3>
        <div className={styles.row}>
          <span className={styles.label}>Throw distance</span>
          <CalcInput
            label="Throw distance"
            testId="calc-throw"
            display={lenText(surface.throw_distance)}
            edit={lenEdit(surface.throw_distance)}
            parse={lengthParse}
            disabled={disabled}
            onCommit={(v) => write({ throw_distance: v })}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Lens ratio</span>
          <CalcInput
            label="Lens ratio"
            testId="calc-lens"
            display={numText(surface.lens_ratio)}
            edit={numText(surface.lens_ratio)}
            parse={numberParse}
            disabled={disabled}
            onCommit={(v) => write({ lens_ratio: v })}
            placeholder="e.g. 1.5"
          />
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Image width</dt>
            <dd data-testid="calc-image-width">{img === null ? "—" : lenText(img)}</dd>
          </div>
          <div>
            <dt>Distance to fill the width</dt>
            <dd>{needDistance === null ? "—" : lenText(needDistance)}</dd>
          </div>
          <div>
            <dt>Lens ratio to fill from here</dt>
            <dd>{needRatio === null ? "—" : `${round(needRatio)}:1`}</dd>
          </div>
        </dl>
      </section>

      {parent && share && (
        <section className={styles.block} aria-label="Region" data-testid="calc-region">
          <h3 className={styles.heading}>Region of {parent.name || parent.channel || "parent"}</h3>
          <p className={styles.muted}>
            Parent canvas:{" "}
            {parent.width !== null && parent.height !== null
              ? `${lenText(parent.width)} × ${lenText(parent.height)}`
              : "size not set"}
            {parent.pixel_width && parent.pixel_height
              ? `, ${parent.pixel_width}×${parent.pixel_height} px`
              : ""}
          </p>
          {share.width !== null && share.height !== null && (
            <div
              className={styles.canvas}
              aria-hidden="true"
              style={{
                aspectRatio:
                  parent.width && parent.height ? `${parent.width} / ${parent.height}` : "16 / 9",
              }}
            >
              <div
                className={styles.region}
                style={{
                  width: `${Math.min(100, share.width * 100)}%`,
                  height: `${Math.min(100, share.height * 100)}%`,
                }}
              />
            </div>
          )}
          <p>
            {share.width !== null ? `${pct(share.width)} of the width` : "Width share unknown"}
            {share.height !== null ? `, ${pct(share.height)} of the height` : ""}
            {share.pixel_width !== null && share.pixel_height !== null
              ? ` ≈ ${share.pixel_width}×${share.pixel_height} px of the parent's canvas`
              : ""}
          </p>
        </section>
      )}
    </div>
  );
}
