// The surface calculator's math (R12, S2; ux.md §Measurements and the surface calculator).
// Physical size (meters), pixel size and PPI are tied by  ppi = pixel_width / width_in_inches
// (square pixels). Two are stored (width, pixel width); PPI is derived, and blank until
// both pixel dimensions are set. Editing one of the three recomputes another so that the
// *locked* one stays put:
//
//   edit ↓ / lock →   physical            pixels              ppi
//   width             pixels stay (PPI)   pixels stay (PPI)   pixel width follows
//   pixel width       size stays (PPI)    size stays (PPI)    width follows
//   PPI               pixels follow       size follows        pixels follow
//
// (Editing the locked quantity itself behaves as if the other stored one were locked.)
// Heights work the same way. With the aspect lock on, changing a width scales the height
// (and a height the width), for the physical size and the pixels alike. The locked PPI and
// the aspect ratios are captured when the lock is engaged (`CalcRefs`) and every edit
// computes from them, so rounding to whole pixels never drifts: going back to a size gives
// back exactly its pixels. Results outside the stored limits are refused. Pure; tested in
// calc.test.ts.
import { MAX_LENGTH_M, MAX_PIXELS, METERS_PER_INCH } from "../../../shared/units";

export type Lock = "physical" | "pixels" | "ppi";

export interface CalcState {
  /** Meters. */
  width: number | null;
  height: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
}

export type CalcField = keyof CalcState | "ppi";

/** Values captured when a lock is engaged; edits compute from these, not the rounded state. */
export interface CalcRefs {
  /** The PPI held by the PPI lock. */
  ppi?: number | null;
  /** height ÷ width, captured when the aspect lock went on. */
  aspect?: { physical: number | null; pixels: number | null } | null;
}

export type CalcResult = Partial<CalcState> | { error: string };

const inches = (m: number) => m / METERS_PER_INCH;
const meters = (inch: number) => inch * METERS_PER_INCH;
const px = (n: number) => Math.max(1, Math.round(n));
const ok = (n: number | null | undefined): n is number =>
  n !== null && n !== undefined && Number.isFinite(n) && n > 0;

/** Pixels per inch (from the width); null unless the width and both pixel sides are set. */
export function ppiOf(s: CalcState): number | null {
  return ok(s.pixel_width) && ok(s.pixel_height) && ok(s.width)
    ? s.pixel_width / inches(s.width)
    : null;
}

/** Millimeters per pixel (same conditions as PPI). */
export function pitchOf(s: CalcState): number | null {
  return ok(s.pixel_width) && ok(s.pixel_height) && ok(s.width)
    ? (s.width * 1000) / s.pixel_width
    : null;
}

/** height ÷ width of the physical size and of the pixels (to capture for the aspect lock). */
export function aspectRefs(s: CalcState): { physical: number | null; pixels: number | null } {
  return {
    physical: ok(s.width) && ok(s.height) ? s.height / s.width : null,
    pixels: ok(s.pixel_width) && ok(s.pixel_height) ? s.pixel_height / s.pixel_width : null,
  };
}

/** Physical and pixel aspect differ by more than 1% (pixels aren't square). */
export function nonSquarePixels(s: CalcState): boolean {
  const a = aspectRefs(s);
  return a.physical !== null && a.pixels !== null && Math.abs(a.pixels / a.physical - 1) > 0.01;
}

/** A proposed change within the stored limits, or why not. */
function checked(s: CalcState, next: CalcState): CalcResult {
  for (const k of ["width", "height"] as const) {
    const v = next[k];
    if (v !== null && v > MAX_LENGTH_M) {
      return { error: `That would make the ${k} ${Math.round(v)} m (at most ${MAX_LENGTH_M} m)` };
    }
  }
  for (const k of ["pixel_width", "pixel_height"] as const) {
    const v = next[k];
    if (v !== null && v > MAX_PIXELS) {
      return {
        error: `That would need ${v} pixels (at most ${MAX_PIXELS.toLocaleString("en-US")})`,
      };
    }
  }
  const out: Partial<CalcState> = {};
  for (const k of ["width", "height", "pixel_width", "pixel_height"] as const) {
    if (next[k] !== s[k]) out[k] = next[k];
  }
  return out;
}

/**
 * The stored fields to write after editing `field` to `value` (null clears it), keeping
 * `lock` fixed and, with `aspect`, the width:height ratio. Only changed fields are returned;
 * `{error}` when a result would be out of range (nothing should be written then).
 */
export function applyCalcEdit(
  s: CalcState,
  field: CalcField,
  value: number | null,
  lock: Lock,
  aspect: boolean,
  refs: CalcRefs = {},
): CalcResult {
  const next: CalcState = { ...s };
  const ppi = ok(refs.ppi) ? refs.ppi : ppiOf(s);
  const ratios = refs.aspect ?? aspectRefs(s);
  switch (field) {
    case "width":
    case "height": {
      const isW = field === "width";
      const other = isW ? "height" : "width";
      const pxSame = isW ? "pixel_width" : "pixel_height";
      const pxOther = isW ? "pixel_height" : "pixel_width";
      next[field] = value;
      if (aspect && ok(value) && ok(ratios.physical)) {
        next[other] = isW ? value * ratios.physical : value / ratios.physical;
      }
      if (lock === "ppi" && ppi !== null) {
        if (ok(value)) next[pxSame] = px(ppi * inches(value));
        const o = next[other];
        if (o !== s[other] && ok(o)) next[pxOther] = px(ppi * inches(o));
      }
      break;
    }
    case "pixel_width":
    case "pixel_height": {
      const isW = field === "pixel_width";
      const other = isW ? "pixel_height" : "pixel_width";
      const lenSame = isW ? "width" : "height";
      const lenOther = isW ? "height" : "width";
      const v = value === null ? null : px(value);
      next[field] = v;
      if (aspect && ok(v) && ok(ratios.pixels)) {
        next[other] = px(isW ? v * ratios.pixels : v / ratios.pixels);
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
  return checked(s, next);
}

/** Pixels for the physical size at `ppi` (a region taking its parent's PPI). */
export function pixelsAtPpi(s: CalcState, ppi: number): CalcResult {
  if (!ok(ppi) || !ok(s.width)) return { error: "Set the region's width first" };
  const next: CalcState = {
    ...s,
    pixel_width: px(ppi * inches(s.width)),
    pixel_height: ok(s.height) ? px(ppi * inches(s.height)) : s.pixel_height,
  };
  return checked(s, next);
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
