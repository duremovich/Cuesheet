// Gallery layout (R19), pure: how many card columns fit, the rows of cards (with group
// headers) the virtualizer renders, and keyboard moves between cards.
import type { Group } from "../../components/grid/types";

/** Narrowest a card gets; 390px phones get two columns. */
export const CARD_MIN = 160;
export const CARD_GAP = 12;
export const GALLERY_PADDING = 12;
export const HEADER_HEIGHT = 36;
/** Image area height as a fraction of card width (4:3). */
export const IMAGE_RATIO = 0.75;
/** Title line + up to 4 field lines + padding. */
const CARD_TEXT = 30 + 4 * 20 + 16;

/** Columns that fit a container `width` px wide (at least 1). */
export function galleryColumns(width: number): number {
  const inner = width - 2 * GALLERY_PADDING;
  return Math.max(1, Math.floor((inner + CARD_GAP) / (CARD_MIN + CARD_GAP)));
}

/** Width of one card with `cols` columns in `width` px. */
export function cardWidth(width: number, cols: number): number {
  const inner = width - 2 * GALLERY_PADDING - (cols - 1) * CARD_GAP;
  return Math.max(CARD_MIN / 2, Math.floor(inner / cols));
}

/** Height of a row of cards (card + gap) for a card `width` wide and `fields` lines. */
export function cardRowHeight(width: number, fields = 4): number {
  return Math.round(width * IMAGE_RATIO) + CARD_TEXT - (4 - fields) * 20 + CARD_GAP;
}

export type GalleryItem<V> =
  | { kind: "header"; key: string; group: Group<V>; count: number }
  | { kind: "cards"; key: string; cards: V[]; groupId: string | null };

/**
 * The virtualized list: a header per group (when grouped), then its cards in rows of
 * `cols`. Empty groups keep their header (as the grid does).
 */
export function galleryItems<V>(
  source: { rows: readonly V[] } | { groups: readonly Group<V>[] },
  cols: number,
  rowId: (v: V) => string,
): GalleryItem<V>[] {
  const out: GalleryItem<V>[] = [];
  const chunk = (rows: readonly V[], groupId: string | null) => {
    for (let i = 0; i < rows.length; i += cols) {
      const cards = rows.slice(i, i + cols);
      out.push({
        kind: "cards",
        key: `r:${groupId ?? ""}:${rowId(cards[0] as V)}`,
        cards,
        groupId,
      });
    }
  };
  if ("groups" in source) {
    for (const g of source.groups) {
      out.push({ kind: "header", key: `h:${g.id}`, group: g, count: g.count ?? g.rows.length });
      chunk(g.rows, g.id);
    }
  } else chunk(source.rows, null);
  return out;
}

/** Where each card is: its item (row) index and column. */
export function cardPositions<V>(
  items: readonly GalleryItem<V>[],
  rowId: (v: V) => string,
): Map<string, { item: number; col: number }> {
  const out = new Map<string, { item: number; col: number }>();
  items.forEach((it, i) => {
    if (it.kind !== "cards") return;
    it.cards.forEach((c, col) => {
      out.set(rowId(c), { item: i, col });
    });
  });
  return out;
}

export type GalleryKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

/**
 * The card a key moves to from `id` (null: stay). ←/→ go through cards in order (across
 * rows and groups); ↑/↓ go to the row above/below at the same column (or its last card),
 * skipping headers; Home/End the first/last card.
 */
export function moveInGallery<V>(
  items: readonly GalleryItem<V>[],
  rowId: (v: V) => string,
  id: string | null,
  key: GalleryKey,
): string | null {
  const rows = items.flatMap((it, i) => (it.kind === "cards" ? [{ i, cards: it.cards }] : []));
  const flat = rows.flatMap((r) => r.cards);
  if (flat.length === 0) return null;
  const first = rowId(flat[0] as V);
  const last = rowId(flat.at(-1) as V);
  if (key === "Home") return first;
  if (key === "End") return last;
  const at = id === null ? -1 : flat.findIndex((c) => rowId(c) === id);
  if (at < 0) return first;
  if (key === "ArrowLeft") return at > 0 ? rowId(flat[at - 1] as V) : null;
  if (key === "ArrowRight") return at < flat.length - 1 ? rowId(flat[at + 1] as V) : null;
  const pos = cardPositions(items, rowId).get(id as string);
  if (!pos) return first;
  const r = rows.findIndex((x) => x.i === pos.item);
  const target = rows[key === "ArrowUp" ? r - 1 : r + 1];
  if (!target) return null;
  const card = target.cards[Math.min(pos.col, target.cards.length - 1)];
  return card === undefined ? null : rowId(card);
}
