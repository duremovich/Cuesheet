import { describe, expect, it, vi } from "vitest";
import type { Column, DataGridHandle } from "../../components/grid/types";
import { click, press, render } from "../../test/dom";
import { quickSetColumns, SelectionBar } from "./SelectionBar";

interface N {
  id: string;
  mine: boolean;
}

const select = (key: string, title: string, values: string[], extra: Partial<Column<N>> = {}) =>
  ({
    key,
    title,
    type: "select",
    options: values.map((value) => ({ value })),
    getValue: () => null,
    ...extra,
  }) as Column<N>;

const COLUMNS: Column<N>[] = [
  { key: "body", title: "Note", type: "longtext", getValue: () => "" },
  select("priority", "Priority", ["1", "2"]),
  select("kind", "Kind", ["A"]),
  select("status", "Status", ["Open", "In progress", "Done"]),
  select("team", "Team", ["LX"]),
  select("locked", "Locked", ["x"], { editable: (n) => n.mine }),
];
const ROWS: N[] = [
  { id: "a", mine: true },
  { id: "b", mine: false },
];

function fakeGrid() {
  const h = {
    focusRow: vi.fn(),
    stepRow: vi.fn(() => null),
    scrollToRow: vi.fn(),
    selectRows: vi.fn(),
    clearSelection: vi.fn(),
    deleteRows: vi.fn(),
  };
  return { ref: { current: h as DataGridHandle }, h };
}

const button = (name: string) => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.textContent === name || x.getAttribute("aria-label") === name,
  );
  if (!b) throw new Error(`no button ${name}`);
  return b;
};

describe("quickSetColumns", () => {
  it("offers select fields every row can take, status first, at most three", () => {
    expect(quickSetColumns(COLUMNS, ROWS).map((c) => c.key)).toEqual([
      "status",
      "priority",
      "kind",
    ]);
    // "locked" is editable on one row only: never offered for both.
    expect(quickSetColumns(COLUMNS.slice(4), ROWS).map((c) => c.key)).toEqual(["team"]);
    expect(quickSetColumns(COLUMNS, [])).toEqual([]);
  });
});

describe("SelectionBar", () => {
  const renderBar = (over: Partial<Parameters<typeof SelectionBar<N>>[0]> = {}) => {
    const grid = fakeGrid();
    const onQuickSet = vi.fn();
    const onSetField = vi.fn();
    render(
      <SelectionBar<N>
        grid={grid.ref}
        targets={["a", "b"]}
        rows={ROWS}
        columns={COLUMNS}
        plural="notes"
        canEdit
        canDelete
        onQuickSet={onQuickSet}
        onSetField={onSetField}
        {...over}
      />,
    );
    return { ...grid, onQuickSet, onSetField };
  };

  it("shows the count; a status pick sets it on every selected row", () => {
    const { onQuickSet } = renderBar();
    const bar = document.querySelector('[data-testid="selection-bar"]') as HTMLElement;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.querySelector('[data-testid="selection-count"]')?.textContent).toBe(
      "2 notes selected",
    );
    click(button("Set Status for 2 notes"));
    const done = [...document.querySelectorAll('[role="menuitem"]')].find(
      (m) => m.textContent === "Done",
    ) as HTMLElement;
    click(done);
    expect(onQuickSet).toHaveBeenCalledTimes(1);
    const [ids, column, value] = onQuickSet.mock.calls[0] ?? [];
    expect(ids).toEqual(["a", "b"]);
    expect((column as Column<N>).key).toBe("status");
    expect(value).toBe("Done");
  });

  it("Set field…, Delete and Clear go to the dialog and the grid; Escape clears", () => {
    const { h, onSetField } = renderBar();
    click(button("Set field…"));
    expect(onSetField).toHaveBeenCalledWith(["a", "b"]);
    click(button("Delete 2 notes"));
    expect(h.deleteRows).toHaveBeenCalledWith(["a", "b"]);
    click(button("Clear selection"));
    expect(h.clearSelection).toHaveBeenCalledTimes(1);
    press("Escape", {}, button("Set field…"));
    expect(h.clearSelection).toHaveBeenCalledTimes(2);
  });

  it("read-only: count and Clear only; nothing for fewer than two rows", () => {
    renderBar({ canEdit: false, canDelete: false });
    const bar = document.querySelector('[data-testid="selection-bar"]') as HTMLElement;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["✕ Clear"]);
    document.body.innerHTML = "";
    renderBar({ targets: ["a"] });
    expect(document.querySelector('[data-testid="selection-bar"]')).toBeNull();
  });
});
