// The PDF page view's zoom setting (a per user and show preference): fit the width, or a
// fixed scale (px per point).
export type Zoom = "fit" | number;

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 4;

export const isZoom = (v: unknown): v is Zoom =>
  v === "fit" || (typeof v === "number" && v >= MIN_SCALE && v <= MAX_SCALE);
