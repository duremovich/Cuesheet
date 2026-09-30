// The DataGrid's `attachment` column type (R13): custom cell content, Enter opens, files
// dropped or pasted onto an editable cell go to `onFiles`, never a text edit.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { pointerDown, press, render } from "../../test/dom";
import { DataGrid } from "./DataGrid";
import type { Column } from "./types";

interface R {
  id: string;
  name: string;
  files: string[];
  locked?: boolean;
}

function setup() {
  const onOpen = vi.fn();
  const onFiles = vi.fn();
  const onEdit = vi.fn();
  const columns: Column<R>[] = [
    { key: "name", title: "Name", type: "text", getValue: (r) => r.name },
    {
      key: "files",
      title: "Files",
      type: "attachment",
      getValue: (r) => r.files,
      format: (v) => (v as string[]).join(", "),
      editable: (r) => !r.locked,
      renderCell: (r) => <span data-testid="strip">{r.files.length} files</span>,
      onOpen,
      onFiles,
    },
  ];
  const rows: R[] = [
    { id: "a", name: "A", files: ["x.png"] },
    { id: "b", name: "B", files: [], locked: true },
  ];
  const { container } = render(
    <DataGrid<R> columns={columns} rowId={(r) => r.id} rows={rows} onEdit={onEdit} />,
  );
  const cell = (id: string) =>
    container.querySelector(`[data-row-id="${id}"] [data-col="files"]`) as HTMLElement;
  return { container, cell, onOpen, onFiles, onEdit };
}

function fileEvent(type: "paste" | "drop" | "dragover", files: File[]) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const data = { files, types: ["Files"], getData: () => "", dropEffect: "none" };
  Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", { value: data });
  return e;
}

describe("DataGrid attachment column", () => {
  it("renders the column's cell content and opens on Enter / double-click", () => {
    const { cell, onOpen, onEdit } = setup();
    expect(cell("a").querySelector("[data-testid='strip']")?.textContent).toBe("1 files");
    pointerDown(cell("a"));
    press("Enter");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    act(() => {
      cell("a").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
    // Typing and Backspace don't edit or clear it.
    press("x");
    press("Backspace");
    expect(onEdit).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("files pasted or dropped on an editable cell go to onFiles; a read-only cell ignores them", () => {
    const { cell, onFiles } = setup();
    const f = new File(["x"], "stage.png", { type: "image/png" });
    pointerDown(cell("a"));
    act(() => {
      cell("a").dispatchEvent(fileEvent("paste", [f]));
    });
    expect(onFiles).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), [f]);
    const over = fileEvent("dragover", [f]);
    act(() => {
      cell("a").dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(cell("a").hasAttribute("data-drop")).toBe(true);
    act(() => {
      cell("a").dispatchEvent(fileEvent("drop", [f]));
    });
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(cell("a").hasAttribute("data-drop")).toBe(false);
    // Locked row: not a drop target.
    const lockedOver = fileEvent("dragover", [f]);
    act(() => {
      cell("b").dispatchEvent(lockedOver);
      cell("b").dispatchEvent(fileEvent("drop", [f]));
    });
    expect(lockedOver.defaultPrevented).toBe(false);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });
});
