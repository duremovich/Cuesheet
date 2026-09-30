// A cue marker in the script margin: "Q 14.22 · LINE" + the trigger text, colored by the
// view's rule, with an open-notes dot and a warning icon for changed/missing anchors.
// Click opens the cue's panel; ⋯ has "Show in list"; editors drag it to another block.
import type { CueRow } from "../../../shared/tables";
import { optionColor } from "../../components/grid/Chip";
import { MenuButton, type MenuEntry } from "../shared/MenuButton";
import type { CueAnchorRow } from "./contract";
import { cueLabel, MARKER_HEIGHT, markerText, NEEDS_LOOK, triggerBadge } from "./markers";
import styles from "./Script.module.css";

export const ANCHOR_DRAG_TYPE = "application/x-cuesheet-anchor";

export interface MarkerActions {
  onOpen(cueId: string): void;
  onShowInList(cueId: string): void;
  /** Editors on the current version: remove the anchor. */
  onRemove?: ((anchorId: string) => void) | undefined;
  onHover?(anchorId: string | null): void;
}

export function markerStyle(color: string | undefined): React.CSSProperties | undefined {
  if (!color) return undefined;
  const c = optionColor(color);
  return {
    "--marker-bg": `var(--option-${c}-bg)`,
    "--marker-fg": `var(--option-${c}-fg)`,
  } as React.CSSProperties;
}

const STATE_LABEL: Record<string, string> = {
  changed: "The line changed in this version: check the placement",
  missing: "Not found in this version",
};

export function Marker({
  anchor,
  cue,
  color,
  openNotes,
  top,
  flash,
  active,
  draggable,
  actions,
}: {
  anchor: CueAnchorRow;
  cue: CueRow;
  color: string | undefined;
  openNotes: number;
  top: number;
  flash: boolean;
  active: boolean;
  draggable: boolean;
  actions: MarkerActions;
}) {
  const label = cueLabel(cue);
  const badge = triggerBadge(cue);
  const text = markerText(cue);
  const warn = NEEDS_LOOK.includes(anchor.state);
  const items: MenuEntry[] = [
    { label: "Open cue", onSelect: () => actions.onOpen(cue.id) },
    { label: "Show in list", onSelect: () => actions.onShowInList(cue.id) },
  ];
  if (actions.onRemove) {
    const remove = actions.onRemove;
    items.push({ label: "Remove from script", onSelect: () => remove(anchor.id) });
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights the quote
    <div
      className={styles.marker}
      data-testid="script-marker"
      data-cue={cue.id}
      data-anchor={anchor.id}
      data-state={anchor.state}
      data-color={color}
      data-positional={anchor.length === 0 || undefined}
      data-flash={flash || undefined}
      data-active={active || undefined}
      style={{ top, height: MARKER_HEIGHT, ...markerStyle(color) }}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(ANCHOR_DRAG_TYPE, anchor.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onMouseEnter={() => actions.onHover?.(anchor.id)}
      onMouseLeave={() => actions.onHover?.(null)}
    >
      <button
        type="button"
        className={styles.markerMain}
        onClick={() => actions.onOpen(cue.id)}
        aria-label={`${label}${badge ? ` · ${badge}` : ""}${text ? `: ${text}` : ""}${warn ? ` (${anchor.state})` : ""}`}
      >
        <span className={styles.markerHead}>
          <strong>{label}</strong>
          {badge && <span className={styles.trigger}>{badge}</span>}
          {openNotes > 0 && (
            <span
              className={styles.notesDot}
              data-testid="marker-notes"
              title={`${openNotes} open ${openNotes === 1 ? "note" : "notes"}`}
            />
          )}
          {warn && (
            <span
              className={styles.warn}
              data-testid="marker-warning"
              title={STATE_LABEL[anchor.state]}
            >
              ⚠
            </span>
          )}
        </span>
        <span className={styles.markerText}>{text}</span>
      </button>
      <div className={styles.markerMenu}>
        <MenuButton label={`More actions for ${label}`} items={items}>
          ⋯
        </MenuButton>
      </div>
    </div>
  );
}

/** A faint marker for another department's cue (LX / SQ number on the cue). */
export function FaintMarker({ text, top }: { text: string; top: number }) {
  return (
    <div className={styles.faint} style={{ top }} data-testid="faint-marker">
      {text}
    </div>
  );
}

/** Other departments' cues shown next to a video cue: "LX 117", "SQ 12" (not its own badge). */
export function otherDeptLabels(cue: CueRow): string[] {
  const own = triggerBadge(cue);
  const out: string[] = [];
  const lx = cue.lx_cue?.trim();
  const sq = cue.sq_cue?.trim();
  if (lx && own !== `LX ${lx}`) out.push(`LX ${lx}`);
  if (sq && own !== `SQ ${sq}`) out.push(`SQ ${sq}`);
  return out;
}
