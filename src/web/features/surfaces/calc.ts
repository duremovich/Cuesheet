// The surface calculator's math (R12, S2; ux.md §Measurements and the surface calculator).
// Physical size (meters), pixel size and PPI are tied by  ppi = pixel_width / width_in_inches
// (square pixels). Two are stored (width, pixel width); PPI is derived. Editing one of the
// three recomputes another so that the *locked* one stays put:
//
//   edit ↓ / lock →   physical            pixels              ppi
//   width             pixels stay (PPI)   pixels stay (PPI)   pixel width follows
//   pixel width       size stays (PPI)    size stays (PPI)    width follows
//   PPI               pixels follow       size follows        pixels follow
//
// (Editing the locked quantity itself behaves as if the other stored one were locked.)
// Heights work the same way. With the aspect lock on, changing a width scales the height
// by the same factor (and a height the width), for the physical size and the pixels
// alike. Pixel counts are rounded to whole pixels. Pure; tested in calc.test.ts.
import { METERS_PER_INCH } from "../../../shared/units";

export type Lock = "physical" | "pixels" | "ppi";

export interface CalcState {
  /** Meters. */
  width: number | null;
  height: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
}

export type CalcField = keyof CalcState | "ppi";

const inches = (m: number) => m / METERS_PER_INCH;
const meters = (inch: number) => inch * METERS_PER_INCH;
const px = (n: number) => Math.max(1, Math.round(n));
const ok = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/** Pixels per inch (from the width), or null when either side is missing. */
export function ppiOf(s: CalcState): number | null {
  return ok(s.pixel_width) && ok(s.width) ? s.pixel_width / inches(s.width) : null;
}

/** Millimeters per pixel. */
export function pitchOf(s: CalcState): number | null {
  return ok(s.pixel_width) && ok(s.width) ? (s.width * 1000) / s.pixel_width : null;
}

/**
 * The stored fields to write after editing `field` to `value` (null clears it), keeping
 * `lock` fixed and, with `aspect`, the width:height ratio. Only changed fields are returned.
 */
export function applyCalcEdit(
  s: CalcState,
  field: CalcField,
  value: number | null,
  lock: Lock,
  aspect: boolean,
): Partial<CalcState> {
  const next: CalcState = { ...s };
  const ppi = ppiOf(s);
  switch (field) {
    case "width":
    case "height": {
      const other = field === "width" ? "height" : "width";
      const pxSame = field === "width" ? "pixel_width" : "pixel_height";
      const pxOther = field === "width" ? "pixel_height" : "pixel_width";
      next[field] = value;
      const old = s[field];
      if (aspect && ok(value) && ok(old) && ok(s[other])) {
        next[other] = (s[other] * value) / old;
      }
      if (lock === "ppi" && ppi !== null) {
        if (ok(value)) next[pxSame] = px(ppi * inches(value));
        if (next[other] !== s[other] && ok(next[other])) {
          next[pxOther] = px(ppi * inches(next[other]));
        }
      }
      break;
    }
    case "pixel_width":
    case "pixel_height": {
      const other = field === "pixel_width" ? "pixel_height" : "pixel_width";
      const lenSame = field === "pixel_width" ? "width" : "height";
      const lenOther = field === "pixel_width" ? "height" : "width";
      next[field] = value === null ? null : px(value);
      const old = s[field];
      const v = next[field];
      if (aspect && ok(v) && ok(old) && ok(s[other])) {
        next[other] = px((s[other] * v) / old);
      }
      if (lock === "ppi" && ppi !== null) {
        if (ok(v)) next[lenSame] = meters(v / ppi);
        const o = next[other];
        if (o !== s[other] && ok(o)) next[lenOther] = meters(o / ppi);
      }
      break;
    }
    case "ppi": {
      if (!ok(value)) break; // PPI isn't stored: clearing it changes nothing
      if (lock === "pixels" && ok(s.pixel_width)) {
        next.width = meters(s.pixel_width / value);
        if (ok(s.pixel_height)) next.height = meters(s.pixel_height / value);
      } else if (ok(s.width)) {
        next.pixel_width = px(value * inches(s.width));
        if (ok(s.height)) next.pixel_height = px(value * inches(s.height));
      } else if (ok(s.pixel_width)) {
        // No physical size yet: derive it from the pixels.
        next.width = meters(s.pixel_width / value);
        if (ok(s.pixel_height)) next.height = meters(s.pixel_height / value);
      }
      break;
    }
  }
  const out: Partial<CalcState> = {};
  for (const k of ["width", "height", "pixel_width", "pixel_height"] as const) {
    if (next[k] !== s[k]) out[k] = next[k];
  }
  return out;
}

/** The lock a surface starts with: pixels for a region of a parent with a pixel canvas. */
export function defaultLock(parent: CalcState | null | undefined): Lock {
  return parent && ok(parent.pixel_width) && ok(parent.pixel_height) ? "pixels" : "physical";
}

// ---- projectors (S2): throw ratio = distance ÷ image width ----

/** Image width (m) from throw distance (m) and lens (throw) ratio. */
export function imageWidth(distance: number | null, ratio: number | null): number | null {
  return ok(distance) && ok(ratio) ? distance / ratio : null;
}

/** Throw distance (m) for an image `width` wide with this lens ratio. */
export function distanceFor(width: number | null, ratio: number | null): number | null {
  return ok(width) && ok(ratio) ? width * ratio : null;
}

/** The lens ratio that fills `width` from `distance`. */
export function ratioFor(distance: number | null, width: number | null): number | null {
  return ok(distance) && ok(width) ? distance / width : null;
}

// ---- regions ----

export interface RegionShare {
  /** Fractions of the parent's width / height (null when a side is unknown). */
  width: number | null;
  height: number | null;
  /** This region's size in the parent's pixels (at the parent's PPI). */
  pixel_width: number | null;
  pixel_height: number | null;
}

export function regionShare(child: CalcState, parent: CalcState): RegionShare {
  const ppi = ppiOf(parent);
  return {
    width: ok(child.width) && ok(parent.width) ? child.width / parent.width : null,
    height: ok(child.height) && ok(parent.height) ? child.height / parent.height : null,
    pixel_width: ppi !== null && ok(child.width) ? px(ppi * inches(child.width)) : null,
    pixel_height: ppi !== null && ok(child.height) ? px(ppi * inches(child.height)) : null,
  };
}
