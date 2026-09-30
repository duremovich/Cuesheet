// Small inline icons (currentColor) for column types and row affordances.

import type { ColumnType } from "./types";

const P = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TYPE_PATHS: Record<ColumnType, string> = {
  text: "M3 4h10M8 4v9",
  longtext: "M3 4h10M3 7h10M3 10h10M3 13h6",
  number: "M6 2.5 4.5 13.5M11.5 2.5 10 13.5M3 6h10.5M2.5 10h10.5",
  checkbox: "M3 3h10v10H3zM5.5 8l2 2 3.5-4",
  select: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.5 7.5l2.5 2.5 2.5-2.5",
  multiselect: "M2.5 4h2M2.5 8h2M2.5 12h2M7 4h6.5M7 8h6.5M7 12h6.5",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  multilink:
    "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1M13 13h1.5",
  readonly: "M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z",
  attachment:
    "M10.5 5.5 6 10a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4L4 8a4.2 4.2 0 0 0 6 6l3.5-3.5",
  measurement: "M2 6h12v4H2zM5 6v2M8 6v2.5M11 6v2",
  pixelsize: "M2.5 3.5h11v9h-11zM5.5 6.5h2M5.5 6.5v2",
  formula: "M11.5 3h-3a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 1 5.5 13h-1M4.5 7.5h5",
};

export function TypeIcon({ type }: { type: ColumnType }) {
  return (
    <svg aria-hidden="true" {...P}>
      <path d={TYPE_PATHS[type]} />
    </svg>
  );
}

export function GripIcon() {
  return (
    <svg aria-hidden="true" {...P} fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.2" />
      <circle cx="10" cy="4" r="1.2" />
      <circle cx="6" cy="8" r="1.2" />
      <circle cx="10" cy="8" r="1.2" />
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="10" cy="12" r="1.2" />
    </svg>
  );
}

export function ExpandIcon() {
  return (
    <svg aria-hidden="true" {...P}>
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      {...P}
      style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg aria-hidden="true" {...P} width={12} height={12}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
