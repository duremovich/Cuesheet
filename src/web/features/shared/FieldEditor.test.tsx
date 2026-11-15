import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Column } from "../../components/grid/types";
import { dblClick, render, setInputValue } from "../../test/dom";
import { FieldEditor } from "./FieldEditor";

interface R {
  qty: number | null;
  body: string;
}
const ROW: R = { qty: 3, body: "" };
const QTY: Column<R> = { key: "qty", title: "Qty", type: "number", getValue: (r) => r.qty };
const BODY: Column<R> = { key: "body", title: "Body", type: "longtext", getValue: (r) => r.body };

const field = (label: string) =>
  document.querySelector<HTMLInputElement & HTMLTextAreaElement>(`[aria-label="${label}"]`);

describe("FieldEditor text drafts", () => {
  it("double-clicking a long-text field being typed in keeps the draft, and blur saves it", () => {
    const onCommit = vi.fn();
    render(<FieldEditor col={BODY} row={ROW} canEdit onCommit={onCommit} />);
    const el = field("Body") as HTMLTextAreaElement;
    act(() => el.focus());
    setInputValue(el, "a note I am still typing");
    dblClick(el);
    expect(el.value).toBe("a note I am still typing");
    act(() => el.blur());
    expect(onCommit).toHaveBeenCalledWith("a note I am still typing");
  });

  it("a refused draft survives focusing the field again", () => {
    const onCommit = vi.fn();
    render(<FieldEditor col={QTY} row={ROW} canEdit onCommit={onCommit} />);
    const el = field("Qty") as HTMLInputElement;
    act(() => el.focus());
    setInputValue(el, "12 apples");
    act(() => el.blur());
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    // Clicking back in to fix it used to reset the field to the stored 3.
    act(() => el.focus());
    expect(el.value).toBe("12 apples");
    setInputValue(el, "12");
    act(() => el.blur());
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  // The panel follows the active row without remounting its fields: a refused draft on one
  // row used to show on the next row's field, where fixing it saved it into that row.
  it("a refused draft stays with its row when the panel moves to another", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const ui = (id: string) => (
      <FieldEditor
        col={QTY}
        row={id === "a" ? ROW : { ...ROW, qty: 5 }}
        recordId={id}
        canEdit
        onCommit={id === "a" ? onA : onB}
      />
    );
    const r = render(ui("a"));
    const el = field("Qty") as HTMLInputElement;
    act(() => el.focus());
    setInputValue(el, "12 apples");
    act(() => el.blur());
    r.rerender(ui("b"));
    expect(el.value).toBe("5");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    act(() => el.focus());
    setInputValue(el, "7");
    act(() => el.blur());
    expect(onB).toHaveBeenCalledWith(7);
    r.rerender(ui("a"));
    expect(el.value).toBe("12 apples");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Not a number: "12 apples"');
    expect(onA).not.toHaveBeenCalled();
  });
});
