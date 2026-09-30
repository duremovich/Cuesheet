import { act, useState } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  click,
  clipboardEvent,
  pointerDown,
  press,
  render,
  setInputValue,
  wait,
} from "../../test/dom";
import { DataGrid } from "./DataGrid";
import type {
  Column,
  DataGridHandle,
  DataGridProps,
  InsertPosition,
  PickerItem,
  SortSpec,
} from "./types";

interface R {
  id: string;
  name: string;
  qty: number | null;
  kind: string | null;
  done: boolean;
  ref: PickerItem | null;
  note: string;
  group: string;
  section?: boolean;
}

const row = (id: string, name: string, extra: Partial<R> = {}): R => ({
  id,
  name,
  qty: null,
  kind: null,
  done: false,
  ref: null,
  note: "",
  group: "g1",
  ...extra,
});

function makeColumns(opts: {
  search?: (q: string) => PickerItem[] | Promise<PickerItem[]>;
  create?: (name: string) => Promise<PickerItem>;
}): Column<R>[] {
  return [
    { key: "name", title: "Name", type: "text", getValue: (r) => r.name },
    { key: "qty", title: "Qty", type: "number", getValue: (r) => r.qty },
    {
      key: "kind",
      title: "Kind",
      type: "select",
      options: [
        { value: "a", label: "Alpha", color: "red" },
        { value: "b", label: "Beta", color: "blue" },
      ],
      getValue: (r) => r.kind,
    },
    { key: "done", title: "Done", type: "checkbox", getValue: (r) => r.done },
    {
      key: "ref",
      title: "Ref",
      type: "link",
      search: opts.search ?? (() => []),
      create: opts.create,
      getValue: (r) => r.ref,
    },
    { key: "note", title: "Note", type: "longtext", getValue: (r) => r.note },
    { key: "info", title: "Info", type: "readonly", getValue: (r) => `#${r.id}` },
  ];
}

type Fn = Mock<(...args: unknown[]) => unknown>;
interface Spies {
  onEdit: Fn;
  onInsert: Fn;
  onDelete: Fn;
  onOpenRow: Fn;
  onMove: Fn;
}

function spies(): Spies {
  const f = () => vi.fn<(...args: unknown[]) => unknown>();
  return { onEdit: f(), onInsert: f(), onDelete: f(), onOpenRow: f(), onMove: f() };
}

function Harness({
  initial,
  s,
  sort,
  grouped,
  columns,
  extra,
  remote,
}: {
  initial: R[];
  s: Spies;
  sort?: SortSpec[];
  grouped?: boolean;
  columns?: Column<R>[];
  extra?: Partial<DataGridProps<R>>;
  /** Receives the row setter, to simulate someone else's edits. */
  remote?: (set: React.Dispatch<React.SetStateAction<R[]>>) => void;
}) {
  const [rows, setRows] = useState(initial);
  remote?.(setRows);
  const [cols] = useState(() => columns ?? makeColumns({}));
  const onInsert = (pos: InsertPosition) => {
    s.onInsert(pos);
    const id = `new${rows.length}`;
    setRows((rs) => {
      const i = pos.afterRowId
        ? rs.findIndex((r) => r.id === pos.afterRowId) + 1
        : pos.beforeRowId
          ? rs.findIndex((r) => r.id === pos.beforeRowId)
          : rs.length;
      const next = [...rs];
      next.splice(i, 0, row(id, "", { group: pos.groupId ?? "g1" }));
      return next;
    });
    return id;
  };
  const common = {
    columns: cols,
    rowId: (r: R) => r.id,
    isSection: (r: R) => !!r.section,
    sort,
    onEdit: (id: string, key: string, v: unknown) => {
      s.onEdit(id, key, v);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: v } : r)));
    },
    onInsert,
    onDelete: (ids: string[]) => {
      s.onDelete(ids);
      setRows((rs) => rs.filter((r) => !ids.includes(r.id)));
    },
    onOpenRow: s.onOpenRow,
    onMove: s.onMove,
  };
  if (grouped) {
    const groups = ["g1", "g2"].map((g) => ({
      id: g,
      title: g === "g1" ? "Scene One" : "Scene Two",
      rows: rows.filter((r) => r.group === g),
    }));
    return <DataGrid<R> {...common} {...extra} groups={groups} />;
  }
  return <DataGrid<R> {...common} {...extra} rows={rows} />;
}

const cell = (rowId: string, key: string) => {
  const r = [...document.querySelectorAll<HTMLElement>("[data-row-id]")].find(
    (el) => el.dataset.rowId === rowId,
  );
  const c = [...(r?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])].find(
    (el) => el.dataset.col === key,
  );
  if (!c) throw new Error(`no cell ${rowId}:${key}`);
  return c;
};
const focused = () => {
  const el = document.activeElement as HTMLElement | null;
  const r = el?.closest<HTMLElement>("[data-row-id]");
  return r ? `${r.dataset.rowId}:${el?.dataset.col ?? el?.tagName}` : String(el?.tagName);
};
const rowOrder = () =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=grid-row]")].map(
    (el) => el.dataset.rowId,
  );
const editor = () => document.querySelector<HTMLInputElement>("[data-editor]");

const THREE = [
  row("r1", "one", { qty: 1 }),
  row("r2", "two", { qty: 2 }),
  row("r3", "three", { qty: 3 }),
];

describe("DataGrid keyboard navigation", () => {
  it("moves with arrows and Tab, and exposes grid roles", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    expect(document.querySelector('[role="grid"]')).not.toBeNull();
    pointerDown(cell("r1", "name"));
    expect(focused()).toBe("r1:name");
    expect(cell("r1", "name").tabIndex).toBe(0);
    expect(cell("r2", "name").tabIndex).toBe(-1);
    press("ArrowDown");
    expect(focused()).toBe("r2:name");
    press("ArrowRight");
    expect(focused()).toBe("r2:qty");
    press("ArrowUp");
    expect(focused()).toBe("r1:qty");
    press("Tab", { shift: true });
    expect(focused()).toBe("r1:name");
    // Tab wraps from the last column to the next row.
    pointerDown(cell("r1", "info"));
    press("Tab");
    expect(focused()).toBe("r2:name");
    expect(cell("r2", "name").getAttribute("aria-selected")).toBe("true");
  });

  it("Space opens the row; Delete clears the cell", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r2", "name"));
    press(" ");
    expect(s.onOpenRow).toHaveBeenCalledWith("r2");
    press("Delete");
    expect(s.onEdit).toHaveBeenCalledWith("r2", "name", "");
    expect(cell("r2", "name").textContent).toBe("");
  });
});

describe("DataGrid editing", () => {
  it("typing starts an edit; Enter commits and moves down", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("x");
    const input = editor();
    expect(input?.value).toBe("x");
    setInputValue(input as HTMLInputElement, "xyz");
    press("Enter");
    expect(s.onEdit).toHaveBeenCalledWith("r1", "name", "xyz");
    expect(cell("r1", "name").textContent).toBe("xyz");
    expect(focused()).toBe("r2:name");
  });

  it("Tab commits and moves right; numbers are parsed", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "qty"));
    press("F2");
    setInputValue(editor() as HTMLInputElement, "1,250.5");
    press("Tab");
    expect(s.onEdit).toHaveBeenCalledWith("r1", "qty", 1250.5);
    expect(focused()).toBe("r1:kind");
  });

  it("Escape cancels without calling onEdit", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("Enter");
    setInputValue(editor() as HTMLInputElement, "changed");
    press("Escape");
    expect(editor()).toBeNull();
    expect(s.onEdit).not.toHaveBeenCalled();
    expect(cell("r1", "name").textContent).toBe("one");
    expect(focused()).toBe("r1:name");
  });

  it("undo and redo replay inverse edits", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("a");
    press("Enter");
    press("b");
    press("Enter");
    expect(cell("r1", "name").textContent).toBe("a");
    expect(cell("r2", "name").textContent).toBe("b");
    press("z", { mod: true });
    expect(s.onEdit).toHaveBeenLastCalledWith("r2", "name", "two");
    press("z", { mod: true });
    expect(s.onEdit).toHaveBeenLastCalledWith("r1", "name", "one");
    expect(cell("r1", "name").textContent).toBe("one");
    press("z", { mod: true, shift: true });
    expect(s.onEdit).toHaveBeenLastCalledWith("r1", "name", "a");
    expect(cell("r1", "name").textContent).toBe("a");
  });

  it("toggles checkboxes with Enter", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r3", "done"));
    press("Enter");
    expect(s.onEdit).toHaveBeenCalledWith("r3", "done", true);
  });

  it("readonly cells don't edit", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "info"));
    press("q");
    expect(editor()).toBeNull();
    press("Delete");
    expect(s.onEdit).not.toHaveBeenCalled();
  });
});

describe("DataGrid long text, insert affordance and column resize", () => {
  it("long text: Ctrl+Enter adds a newline, Enter commits", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "note"));
    press("Enter");
    const area = editor() as unknown as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    setInputValue(area, "line 1");
    area.setSelectionRange(6, 6);
    press("Enter", { mod: true }, area);
    expect(area.value).toBe("line 1\n");
    setInputValue(area, "line 1\nline 2");
    press("Enter", {}, area);
    expect(s.onEdit).toHaveBeenCalledWith("r1", "note", "line 1\nline 2");
  });

  it("the + between rows inserts below", async () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    const plus = document.querySelector('[aria-label="Insert row below row 1"]') as HTMLElement;
    click(plus);
    await wait();
    expect(s.onInsert).toHaveBeenCalledWith({ afterRowId: "r1" });
    expect(rowOrder()).toEqual(["r1", "new3", "r2", "r3"]);
    expect(focused()).toBe("new3:name");
  });

  it("resizes a column by dragging its header edge", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    const handle = document.querySelector('[data-testid="resize-name"]') as HTMLElement;
    const header = handle.parentElement as HTMLElement;
    expect(header.style.width).toBe("160px");
    const Ctor = (window.PointerEvent ?? MouseEvent) as typeof MouseEvent;
    act(() => {
      handle.dispatchEvent(new Ctor("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
      window.dispatchEvent(new Ctor("pointermove", { clientX: 150 }));
      window.dispatchEvent(new Ctor("pointerup", { clientX: 150 }));
    });
    expect(header.style.width).toBe("210px");
    expect(cell("r1", "name").style.width).toBe("210px");
  });
});

describe("DataGrid review fixes", () => {
  it("ignores Enter and Escape during IME composition", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("Enter");
    const input = editor() as HTMLInputElement;
    setInputValue(input, "かな");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    expect(editor()).not.toBeNull();
    expect(s.onEdit).not.toHaveBeenCalled();
    press("Enter");
    expect(s.onEdit).toHaveBeenCalledWith("r1", "name", "かな");
  });

  it("a double Enter on Create with a slow search creates once", async () => {
    const s = spies();
    const create = vi.fn(async (name: string) => ({ id: "n1", label: name }));
    const search = () => new Promise<PickerItem[]>((r) => setTimeout(() => r([]), 50));
    render(<Harness initial={THREE} s={s} columns={makeColumns({ search, create })} />);
    pointerDown(cell("r1", "ref"));
    press("Z");
    const input = document.activeElement as HTMLInputElement;
    press("Enter", {}, input);
    press("Enter", {}, input);
    await wait(120);
    expect(create).toHaveBeenCalledTimes(1);
    expect(s.onEdit).toHaveBeenCalledTimes(1);
  });

  it("one keystroke while editing re-renders at most two rows", () => {
    const s = spies();
    const calls: string[] = [];
    const columns = makeColumns({}).map((c) =>
      c.key === "qty"
        ? {
            ...c,
            getValue: (r: R) => {
              calls.push(r.id);
              return r.qty;
            },
          }
        : c,
    );
    const many = Array.from({ length: 12 }, (_, i) => row(`m${i}`, `n${i}`, { qty: i }));
    render(<Harness initial={many} s={s} columns={columns} />);
    pointerDown(cell("m3", "name"));
    press("x");
    calls.length = 0;
    setInputValue(editor() as HTMLInputElement, "xy");
    expect(new Set(calls).size).toBeLessThanOrEqual(2);
  });

  it("pasting across a section row skips it without consuming a pasted row", () => {
    const s = spies();
    const rows = [row("a", "1"), row("sec", "ACT 2", { section: true }), row("b", "2")];
    render(<Harness initial={rows} s={s} />);
    pointerDown(cell("a", "name"));
    const { event } = clipboardEvent("paste", { "text/plain": "X\nY" });
    act(() => cell("a", "name").dispatchEvent(event));
    expect(s.onEdit.mock.calls).toEqual([
      ["a", "name", "X"],
      ["b", "name", "Y"],
    ]);
  });

  it("group headers are keyboard rows: arrow onto them, Enter toggles, focus stays", () => {
    const s = spies();
    const rows = [row("a", "one"), row("b", "two", { group: "g2" })];
    render(<Harness initial={rows} s={s} grouped />);
    pointerDown(cell("b", "name"));
    press("ArrowUp");
    const header = document.querySelector('[data-group-id="g2"] [data-cell]') as HTMLElement;
    expect(document.activeElement).toBe(header);
    // Group buttons are out of the tab order.
    for (const b of document.querySelectorAll('[data-testid="group-header"] button'))
      expect((b as HTMLElement).tabIndex).toBe(-1);
    press("Enter");
    expect(rowOrder()).toEqual(["a"]);
    expect(document.activeElement).toBe(document.querySelector('[data-group-id="g2"] [data-cell]'));
    press("ArrowRight");
    expect(rowOrder()).toEqual(["a", "b"]);
    press("ArrowDown");
    expect(focused()).toBe("b:name");
  });

  it("collapsing the active row's group moves focus to its header", () => {
    const s = spies();
    const rows = [row("a", "one"), row("b", "two", { group: "g2" })];
    const collapsed: string[][] = [];
    const Controlled = () => {
      const [ids, setIds] = useState<string[]>([]);
      return (
        <Harness
          initial={rows}
          s={s}
          grouped
          extra={{
            collapsed: ids,
            onCollapsedChange: (next) => {
              collapsed.push(next);
              setIds(next);
            },
          }}
        />
      );
    };
    render(<Controlled />);
    pointerDown(cell("b", "name"));
    click(document.querySelector('[aria-label="Collapse Scene Two"]') as HTMLElement);
    expect(collapsed.at(-1)).toEqual(["g2"]);
    expect(document.activeElement).toBe(document.querySelector('[data-group-id="g2"] [data-cell]'));
  });

  it("a cell focused by Tab (or programmatically) becomes the active cell", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    const first = cell("r1", "name");
    expect(first.tabIndex).toBe(0);
    act(() => first.focus());
    expect(first.dataset.active).toBe("true");
    press("ArrowDown");
    expect(focused()).toBe("r2:name");
  });

  it("ghost suggestions show on the active empty cell; Tab accepts, typing replaces", () => {
    const s = spies();
    const rows = [row("a", "14.2"), row("n", ""), row("b", "14.4")];
    render(
      <Harness
        initial={rows}
        s={s}
        extra={{
          cellDecoration: (r, key) =>
            key === "name" && r.id === "n" ? { ghost: "14.3", warning: "Check me" } : undefined,
        }}
      />,
    );
    expect(cell("n", "name").getAttribute("title")).toBe("Check me");
    pointerDown(cell("n", "name"));
    expect(cell("n", "name").querySelector('[data-testid="ghost"]')?.textContent).toBe("14.3");
    press("Tab");
    expect(s.onEdit).toHaveBeenCalledWith("n", "name", "14.3");
    expect(focused()).toBe("n:qty");
  });

  it("undo skips a cell someone else changed since", () => {
    const s = spies();
    let setRows: React.Dispatch<React.SetStateAction<R[]>> = () => {};
    render(<Harness initial={THREE} s={s} remote={(set) => (setRows = set)} />);
    pointerDown(cell("r1", "name"));
    press("a");
    press("Enter");
    act(() => setRows((rs) => rs.map((r) => (r.id === "r1" ? { ...r, name: "theirs" } : r))));
    s.onEdit.mockClear();
    press("z", { mod: true });
    expect(s.onEdit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Skipped 1 cell/);
  });

  it("exposes focusRow / scrollToRow and reports the active row", () => {
    const s = spies();
    const handle: { current: DataGridHandle | null } = { current: null };
    const onActiveRowChange = vi.fn();
    render(<Harness initial={THREE} s={s} extra={{ ref: handle, onActiveRowChange }} />);
    act(() => handle.current?.focusRow("r3", "qty"));
    expect(focused()).toBe("r3:qty");
    expect(onActiveRowChange).toHaveBeenLastCalledWith("r3");
    act(() => handle.current?.scrollToRow("r1"));
    expect(focused()).toBe("r3:qty");
  });

  it("stepRow moves the active row without taking focus; onEscape fires only when idle", () => {
    const s = spies();
    const handle: { current: DataGridHandle | null } = { current: null };
    const onActiveRowChange = vi.fn();
    const onEscape = vi.fn();
    render(<Harness initial={THREE} s={s} extra={{ ref: handle, onActiveRowChange, onEscape }} />);
    act(() => handle.current?.focusRow("r1", "qty"));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    let id: string | null = null;
    act(() => {
      id = handle.current?.stepRow(1) ?? null;
    });
    expect(id).toBe("r2");
    expect(onActiveRowChange).toHaveBeenLastCalledWith("r2");
    expect(document.activeElement).toBe(outside);
    outside.remove();

    act(() => handle.current?.focusRow("r2", "qty"));
    // A range is cancellable: the first Escape clears it, the second reaches onEscape.
    press("ArrowDown", { shift: true });
    press("Escape");
    expect(onEscape).not.toHaveBeenCalled();
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    // While editing, Escape cancels the edit only.
    press("Enter");
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("offers Duplicate only on rows you can edit", () => {
    const s = spies();
    const cols = makeColumns({}).map((c) => ({
      ...c,
      editable: (r: R) => r.id !== "r2",
    }));
    render(<Harness initial={THREE} s={s} columns={cols} />);
    const menuFor = (id: string) => {
      act(() => {
        document.querySelector(`[data-row-id="${id}"]`)?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
          }),
        );
      });
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
        (m) => m.firstChild?.textContent,
      );
      press("Escape");
      return labels;
    };
    expect(menuFor("r1")).toContain("Duplicate row");
    expect(menuFor("r2")).not.toContain("Duplicate row");
    click(cell("r2", "name"));
    press("d", { mod: true });
    expect(s.onInsert).not.toHaveBeenCalled();
  });

  it("labels the group add button", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} grouped extra={{ addRowLabel: "Add cue" }} />);
    expect(document.querySelector('[aria-label="Add cue to Scene One"]')?.textContent).toContain(
      "Add cue",
    );
  });

  it("adds extra menu items and reports callback errors inline", async () => {
    const s = spies();
    const onError = vi.fn();
    const pick = vi.fn();
    render(
      <Harness
        initial={THREE}
        s={s}
        extra={{
          extraMenuItems: ({ rowId }) => [{ label: "Show in script", onSelect: () => pick(rowId) }],
          onInsert: () => Promise.reject(new Error("offline")),
          onError,
        }}
      />,
    );
    pointerDown(cell("r1", "name"));
    press("ContextMenu");
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((m) => m.firstChild?.textContent)).toContain("Show in script");
    click(items.find((m) => m.firstChild?.textContent === "Show in script") as HTMLElement);
    expect(pick).toHaveBeenCalledWith("r1");
    press("Enter", { mod: true, shift: true });
    await wait();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "insert");
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Couldn't insert/);
  });
});

describe("DataGrid live sort", () => {
  it("holds an edited row in place until focus leaves it, then moves it", async () => {
    const s = spies();
    const rows = [row("a", "apple"), row("b", "banana"), row("c", "cherry")];
    render(<Harness initial={rows} s={s} sort={[{ key: "name", dir: "asc" }]} />);
    expect(rowOrder()).toEqual(["a", "b", "c"]);
    pointerDown(cell("a", "name"));
    press("Enter");
    setInputValue(editor() as HTMLInputElement, "zucchini");
    press("Tab"); // commit, stay in the row
    expect(s.onEdit).toHaveBeenCalledWith("a", "name", "zucchini");
    expect(rowOrder()).toEqual(["a", "b", "c"]);
    const moved = document.querySelector<HTMLElement>('[data-row-id="a"]');
    expect(moved?.dataset.moved).toBeUndefined();
    press("Escape"); // focus leaves the row
    expect(rowOrder()).toEqual(["b", "c", "a"]);
    expect(document.querySelector<HTMLElement>('[data-row-id="a"]')?.dataset.moved).toBe("true");
  });

  it("keeps an inserted row where it was inserted, and focuses its first editable cell", async () => {
    const s = spies();
    const rows = [row("a", "10"), row("b", "20"), row("c", "30")];
    render(<Harness initial={rows} s={s} sort={[{ key: "name", dir: "asc" }]} />);
    pointerDown(cell("a", "name"));
    press("Enter", { mod: true, shift: true });
    await wait();
    expect(s.onInsert).toHaveBeenCalledWith({ afterRowId: "a" });
    // Empty values sort last, but the new row holds its place right after "a".
    expect(rowOrder()).toEqual(["a", "new3", "b", "c"]);
    expect(focused()).toBe("new3:name");
    press("2");
    setInputValue(editor() as HTMLInputElement, "25");
    press("Tab");
    expect(rowOrder()).toEqual(["a", "new3", "b", "c"]);
    // Moving to another row releases it into sorted position.
    press("ArrowDown");
    expect(rowOrder()).toEqual(["a", "b", "new3", "c"]);
  });

  it("inserts above with Ctrl+Shift+ArrowUp", async () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r2", "qty"));
    press("ArrowUp", { mod: true, shift: true });
    await wait();
    expect(s.onInsert).toHaveBeenCalledWith({ beforeRowId: "r2" });
    expect(rowOrder()).toEqual(["r1", "new3", "r2", "r3"]);
    expect(focused()).toBe("new3:name");
  });
});

describe("DataGrid pickers", () => {
  it("select: typing filters options, Enter picks", async () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "kind"));
    press("b");
    await wait(20);
    const input = document.activeElement as HTMLInputElement;
    expect(input.getAttribute("role")).toBe("combobox");
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(["Alpha", "Beta"].filter((x) => x.toLowerCase().includes("b")));
    press("Enter", {}, input);
    await wait();
    expect(s.onEdit).toHaveBeenCalledWith("r1", "kind", "b");
    expect(document.querySelector('[data-testid="record-picker"]')).toBeNull();
    expect(cell("r1", "kind").textContent).toBe("Beta");
  });

  it("link: offers Create when nothing matches and links the created record", async () => {
    const s = spies();
    const create = vi.fn(async (name: string) => ({ id: "x9", label: name }));
    const search = vi.fn((q: string) =>
      [{ id: "x1", label: "Overture" }].filter((i) =>
        i.label.toLowerCase().includes(q.toLowerCase()),
      ),
    );
    const columns = makeColumns({ search, create });
    render(<Harness initial={THREE} s={s} columns={columns} />);
    pointerDown(cell("r1", "ref"));
    press("N");
    const input = document.activeElement as HTMLInputElement;
    setInputValue(input, "New thing");
    await wait(150);
    expect(search).toHaveBeenCalledWith("New thing", expect.objectContaining({ id: "r1" }));
    const opts = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(["+Create “New thing”"]);
    press("Enter", {}, input);
    await wait();
    expect(create).toHaveBeenCalledWith("New thing", expect.objectContaining({ id: "r1" }));
    expect(s.onEdit).toHaveBeenCalledWith("r1", "ref", { id: "x9", label: "New thing" });
    expect(cell("r1", "ref").textContent).toBe("New thing");

    // The created record is now recent: it's offered first next time.
    pointerDown(cell("r2", "ref"));
    press("N");
    await wait(150);
    const opts2 = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts2[0]).toContain("New thing");
    expect(opts2[0]).toContain("recent");
  });

  it("link: Enter before the debounce fires uses fresh results", async () => {
    const s = spies();
    const search = vi.fn((q: string) =>
      [
        { id: "x1", label: "Overture" },
        { id: "x2", label: "Vamp" },
      ].filter((i) => i.label.toLowerCase().includes(q.toLowerCase())),
    );
    render(<Harness initial={THREE} s={s} columns={makeColumns({ search })} />);
    pointerDown(cell("r1", "ref"));
    press("v");
    const input = document.activeElement as HTMLInputElement;
    setInputValue(input, "vamp");
    press("Enter", {}, input);
    await wait();
    expect(s.onEdit).toHaveBeenCalledWith("r1", "ref", { id: "x2", label: "Vamp" });
  });
});

describe("DataGrid clipboard", () => {
  it("pastes TSV into a range starting at the active cell (text/number/select only)", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    const { event } = clipboardEvent("paste", { "text/plain": "A\t10\tbeta\tyes\nB\tx\talpha\n" });
    act(() => cell("r1", "name").dispatchEvent(event));
    expect(s.onEdit.mock.calls).toEqual([
      ["r1", "name", "A"],
      ["r1", "qty", 10],
      ["r1", "kind", "b"],
      ["r2", "name", "B"],
      ["r2", "kind", "a"],
    ]);
    // One undo reverts the whole paste.
    press("z", { mod: true });
    expect(cell("r1", "name").textContent).toBe("one");
    expect(cell("r2", "kind").textContent).toBe("");
  });

  it("fills a selected range with a single pasted value", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("ArrowDown", { shift: true });
    press("ArrowDown", { shift: true });
    const { event } = clipboardEvent("paste", { "text/plain": "same" });
    act(() => cell("r1", "name").dispatchEvent(event));
    expect(s.onEdit.mock.calls.map((c) => c[2])).toEqual(["same", "same", "same"]);
  });

  it("copies the range as TSV", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("ArrowRight", { shift: true });
    press("ArrowDown", { shift: true });
    const { event, store } = clipboardEvent("copy");
    act(() => cell("r1", "name").dispatchEvent(event));
    expect(store["text/plain"]).toBe("one\t1\ntwo\t2");
  });
});

describe("DataGrid selection, groups and menus", () => {
  it("selects rows via row numbers; deleting several asks first, then focuses a neighbor", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    const nums = () => [...document.querySelectorAll<HTMLElement>('[data-testid="row-number"]')];
    const selectedIds = () =>
      [...document.querySelectorAll("[data-selected]")].map(
        (e) => (e as HTMLElement).dataset.rowId,
      );
    click(nums()[0] as HTMLElement);
    click(nums()[2] as HTMLElement, { shift: true });
    expect(selectedIds()).toEqual(["r1", "r2", "r3"]);
    click(nums()[1] as HTMLElement, { mod: true }); // toggles r2 off; r2 becomes active
    expect(selectedIds()).toEqual(["r1", "r3"]);
    // The active row isn't in the selection: Delete clears its cell instead of deleting rows.
    press("Delete");
    expect(s.onDelete).not.toHaveBeenCalled();
    expect(cell("r2", "name").textContent).toBe("");
    click(nums()[2] as HTMLElement, { mod: true }); // r3 off
    click(nums()[2] as HTMLElement, { mod: true }); // r3 on again, active
    expect(selectedIds()).toEqual(["r1", "r3"]);
    press("Delete");
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Delete 2 rows?");
    expect(s.onDelete).not.toHaveBeenCalled();
    click(
      [...dialog.querySelectorAll("button")].find(
        (b) => b.textContent === "Delete 2 rows",
      ) as HTMLElement,
    );
    expect(s.onDelete).toHaveBeenCalledWith(["r1", "r3"]);
    expect(rowOrder()).toEqual(["r2"]);
    expect(focused()).toBe("r2:name");
  });

  it("Backspace never deletes rows; arrows clear a stale row selection", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    const nums = [...document.querySelectorAll<HTMLElement>('[data-testid="row-number"]')];
    click(nums[1] as HTMLElement);
    expect(document.querySelectorAll("[data-selected]").length).toBe(1);
    press("Backspace");
    expect(s.onDelete).not.toHaveBeenCalled();
    expect(s.onEdit).toHaveBeenCalledWith("r2", "name", "");
    press("ArrowDown");
    expect(document.querySelectorAll("[data-selected]").length).toBe(0);
    press("Delete"); // no selection any more: clears r3's cell
    expect(s.onDelete).not.toHaveBeenCalled();
    expect(s.onEdit).toHaveBeenLastCalledWith("r3", "name", "");
  });

  it("deleting the active row moves focus to the next row", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r2", "qty"));
    press("ContextMenu");
    const del = [...document.querySelectorAll('[role="menuitem"]')].find(
      (m) => m.firstChild?.textContent === "Delete row",
    );
    click(del as HTMLElement);
    expect(s.onDelete).toHaveBeenCalledWith(["r2"]);
    expect(focused()).toBe("r3:qty");
  });

  it("Ctrl+A selects all rows", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    pointerDown(cell("r1", "name"));
    press("a", { mod: true });
    expect(document.querySelectorAll("[data-selected]").length).toBe(3);
  });

  it("renders group headers with counts, collapses, and adds rows to a group", async () => {
    const s = spies();
    const rows = [
      row("a", "one"),
      row("b", "two", { group: "g2" }),
      row("c", "three", { group: "g2" }),
    ];
    render(<Harness initial={rows} s={s} grouped />);
    const headers = [...document.querySelectorAll<HTMLElement>('[data-testid="group-header"]')];
    expect(headers.map((h) => h.textContent)).toEqual([
      expect.stringContaining("Scene One1"),
      expect.stringContaining("Scene Two2"),
    ]);
    const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Collapse Scene Two"]');
    click(collapse as HTMLButtonElement);
    expect(rowOrder()).toEqual(["a"]);
    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand Scene Two"]');
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    click(expand as HTMLButtonElement);
    expect(rowOrder()).toEqual(["a", "b", "c"]);
    click(document.querySelector('[aria-label="Add row to Scene One"]') as HTMLElement);
    await wait();
    expect(s.onInsert).toHaveBeenCalledWith({ groupId: "g1" });
    expect(focused()).toBe("new3:name");
  });

  it("renders section rows full width with their label", () => {
    const s = spies();
    const rows = [row("a", "one"), row("sec", "INTERMISSION", { section: true }), row("b", "two")];
    render(<Harness initial={rows} s={s} />);
    const sec = document.querySelector<HTMLElement>('[data-row-id="sec"]');
    expect(sec?.dataset.section).toBe("true");
    expect(sec?.querySelectorAll("[data-cell]").length).toBe(1);
    expect(sec?.textContent).toContain("INTERMISSION");
    // Row numbers skip sections.
    const nums = [...document.querySelectorAll('[data-testid="row-number"]')].map(
      (n) => n.textContent,
    );
    expect(nums).toEqual(["1", "", "2"]);
  });

  it("context menu offers insert, duplicate, open and delete", async () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} />);
    act(() => {
      document.querySelector('[data-row-id="r2"]')?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (m) => m.firstChild?.textContent,
    );
    expect(items).toEqual([
      "Insert row above",
      "Insert row below",
      "Duplicate row",
      "Open",
      "Delete row",
    ]);
    click([...document.querySelectorAll('[role="menuitem"]')][2] as HTMLElement);
    await wait();
    expect(s.onInsert).toHaveBeenCalledWith({ afterRowId: "r2" });
    // Duplicate copies editable, non-empty values into the new row.
    expect(s.onEdit).toHaveBeenCalledWith("new3", "name", "two");
    expect(s.onEdit).toHaveBeenCalledWith("new3", "qty", 2);
    expect(s.onEdit).not.toHaveBeenCalledWith("new3", "info", expect.anything());
  });

  it("shows a hint instead of dragging while a live sort is on", () => {
    const s = spies();
    render(<Harness initial={THREE} s={s} sort={[{ key: "name", dir: "asc" }]} />);
    const handle = document.querySelector('[data-testid="drag-handle"]') as HTMLElement;
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    pointerDown(handle);
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/live sort/);
  });
});
