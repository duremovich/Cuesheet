import { describe, expect, it } from "vitest";
import {
  CARD_MIN,
  cardRowHeight,
  cardWidth,
  galleryColumns,
  galleryItems,
  moveInGallery,
} from "./gallery";

const id = (v: string) => v;

describe("gallery layout", () => {
  it("fits columns to the width: two on a 390px phone", () => {
    expect(galleryColumns(390)).toBe(2);
    expect(galleryColumns(200)).toBe(1);
    expect(galleryColumns(0)).toBe(1);
    expect(galleryColumns(1000)).toBe(5);
    expect(cardWidth(390, 2)).toBeGreaterThanOrEqual(CARD_MIN);
    // Cards fill the row: n cards + gaps + padding = width.
    expect(cardWidth(1000, 5) * 5 + 4 * 12 + 24).toBeLessThanOrEqual(1000);
    expect(cardRowHeight(200)).toBeGreaterThan(200 * 0.75);
    expect(cardRowHeight(200, 2)).toBe(cardRowHeight(200) - 40);
  });

  it("chunks rows into card rows, with a header per group", () => {
    expect(galleryItems({ rows: ["a", "b", "c"] }, 2, id).map((i) => i.kind)).toEqual([
      "cards",
      "cards",
    ]);
    const items = galleryItems(
      {
        groups: [
          { id: "g1", title: "One", rows: ["a", "b", "c"] },
          { id: "g2", title: "Empty", rows: [] },
          { id: "g3", title: "Three", rows: ["d"] },
        ],
      },
      2,
      id,
    );
    expect(items.map((i) => (i.kind === "header" ? `h:${i.group.id}` : i.cards.join("")))).toEqual([
      "h:g1",
      "ab",
      "c",
      "h:g2",
      "h:g3",
      "d",
    ]);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("moves with the keyboard: across rows and groups; up/down keep the column", () => {
    const items = galleryItems(
      {
        groups: [
          { id: "g1", title: "One", rows: ["a", "b", "c"] },
          { id: "g2", title: "Two", rows: ["d", "e", "f", "g"] },
        ],
      },
      3,
      id,
    );
    // g1: [a b c]; g2: [d e f] [g]
    expect(moveInGallery(items, id, "a", "ArrowRight")).toBe("b");
    expect(moveInGallery(items, id, "c", "ArrowRight")).toBe("d");
    expect(moveInGallery(items, id, "a", "ArrowLeft")).toBeNull();
    expect(moveInGallery(items, id, "b", "ArrowDown")).toBe("e");
    expect(moveInGallery(items, id, "f", "ArrowDown")).toBe("g"); // shorter row: its last card
    expect(moveInGallery(items, id, "g", "ArrowDown")).toBeNull();
    expect(moveInGallery(items, id, "e", "ArrowUp")).toBe("b");
    expect(moveInGallery(items, id, "a", "ArrowUp")).toBeNull();
    expect(moveInGallery(items, id, null, "ArrowDown")).toBe("a");
    expect(moveInGallery(items, id, "e", "Home")).toBe("a");
    expect(moveInGallery(items, id, "a", "End")).toBe("g");
    expect(moveInGallery([], id, null, "End")).toBeNull();
  });
});
