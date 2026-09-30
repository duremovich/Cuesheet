import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { click, press, render, setInputValue, wait } from "../../test/dom";
import type { CueAnchorRow } from "./contract";
import { NO_FILTER } from "./filters";
import { MARKER_GAP, MARKER_HEIGHT } from "./markers";
import { type Placement, Reader, type ReaderProps } from "./Reader";
import { anchorRow, cueRow, SAMPLE } from "./testData";

const cues = new Map([
  ["c1", cueRow({ id: "c1", number: "14.20", trigger_type: "Line", trigger_value: "Sweet Sue" })],
  ["c2", cueRow({ id: "c2", number: "14.25", trigger_type: "LX", lx_cue: "117" })],
  ["c3", cueRow({ id: "c3", number: "14.30", status: "Cued" })],
]);

function setup(over: Partial<ReaderProps> = {}, anchors?: CueAnchorRow[]) {
  const placement: Placement = {
    create: vi.fn(async () => undefined),
    attach: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    suggest: vi.fn(() => "14.22"),
    searchCues: vi.fn(() => [{ id: "c3", label: "14.30" }]),
  };
  const actions = { onOpen: vi.fn(), onShowInList: vi.fn() };
  const props: ReaderProps = {
    text: SAMPLE,
    anchors: anchors ?? [
      anchorRow({ id: "a1", cue_id: "c1", block: 5, offset: 0, length: 9, quote: "Sweet Sue" }),
      anchorRow({ id: "a2", cue_id: "c2", block: 5, offset: 20 }),
      anchorRow({ id: "a3", cue_id: "c3", block: 5, offset: 25 }),
    ],
    cues,
    assignees: new Map(),
    openNotes: new Map([["c1", 2]]),
    fieldOptions: {},
    filter: NO_FILTER,
    colorBy: "status",
    showOthers: false,
    canPlace: true,
    activeCue: null,
    focusRequest: null,
    actions,
    placement,
    ...over,
  };
  const r = render(<Reader {...props} />);
  return { ...r, placement, actions, props };
}

const markers = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLElement>('[data-testid="script-marker"]'),
];
const popover = () => document.querySelector<HTMLElement>('[data-testid="place-popover"]');
const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLElement;

function selectIn(container: HTMLElement, block: number, start: number, end: number) {
  const text = container.querySelector(`[data-block="${block}"] [data-text]`) as HTMLElement;
  const node = text.firstChild?.firstChild as Text; // one segment span → its text node
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  act(() => {
    text.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("Reader markers", () => {
  it("stacks markers that share a block, one below the other", () => {
    const { container } = setup();
    const m = markers(container);
    expect(m.map((x) => x.dataset.cue)).toEqual(["c1", "c2", "c3"]);
    const tops = m.map((x) => Number.parseFloat(x.style.top));
    // jsdom has no layout: every block measures at 0, so the stack starts at 0.
    expect(tops).toEqual([0, MARKER_HEIGHT + MARKER_GAP, 2 * (MARKER_HEIGHT + MARKER_GAP)]);
    expect(m[0]?.textContent).toContain("Q 14.20");
    expect(m[0]?.textContent).toContain("LINE");
    expect(m[1]?.textContent).toContain("LX 117");
    expect(m[1]?.dataset.positional).toBe("true");
    expect(m[0]?.querySelector('[data-testid="marker-notes"]')).not.toBeNull();
  });

  it("underlines line anchors and filters markers", () => {
    const { container, rerender, props } = setup();
    const q = container.querySelector('[data-quote="a1"]');
    expect(q?.textContent).toBe("Sweet Sue");
    rerender(<Reader {...props} filter={{ ...NO_FILTER, status: "Cued" }} />);
    expect(markers(container).map((x) => x.dataset.cue)).toEqual(["c3"]);
    expect(container.querySelector('[data-quote="a1"]')).toBeNull();
  });

  it("flags changed / missing anchors and hides missing ones", () => {
    const { container } = setup({}, [
      anchorRow({ id: "a1", cue_id: "c1", block: 5, state: "changed" }),
      anchorRow({ id: "a2", cue_id: "c2", block: 5, state: "missing" }),
    ]);
    const m = markers(container);
    expect(m).toHaveLength(1);
    expect(m[0]?.querySelector('[data-testid="marker-warning"]')).not.toBeNull();
  });

  it("drops a dragged marker on another block (editors only)", () => {
    const { container, placement } = setup();
    const drop = (el: Element) => {
      const data = new Map([["application/x-cuesheet-anchor", "a2"]]);
      const e = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", {
        value: { types: [...data.keys()], getData: (t: string) => data.get(t) ?? "" },
      });
      act(() => {
        el.dispatchEvent(e);
      });
    };
    expect(markers(container)[1]?.getAttribute("draggable")).toBe("true");
    drop(container.querySelector('[data-block="3"] [data-text]') as Element);
    expect(placement.move).toHaveBeenCalledWith("a2", 3);
  });

  it("opens the cue from a marker", () => {
    const { container, actions } = setup();
    click(markers(container)[0]?.querySelector("button") as HTMLElement);
    expect(actions.onOpen).toHaveBeenCalledWith("c1");
  });
});

describe("Reader placement popover", () => {
  it("selection → New cue on this line: suggested number, Line trigger, the quote", async () => {
    const { container, placement } = setup({}, []);
    selectIn(container, 7, 0, 7); // "Daphne."
    await wait(30);
    const pop = popover() as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.textContent).toContain("page 13");
    expect(placement.suggest).toHaveBeenCalledWith({ block: 7, offset: 0 });
    click(button(pop, "New cue on this line"));
    const number = pop.querySelector<HTMLInputElement>('input[aria-label="Cue number"]');
    expect(number?.value).toBe("14.22");
    expect(pop.querySelector<HTMLInputElement>('input[aria-label="Trigger value"]')?.value).toBe(
      "Daphne.",
    );
    setInputValue(
      pop.querySelector('input[aria-label="Description"]') as HTMLInputElement,
      "Blue wash",
    );
    click(button(pop, "Create cue"));
    await wait(10);
    expect(placement.create).toHaveBeenCalledWith(
      expect.objectContaining({ block: 7, offset: 0, length: 7, quote: "Daphne." }),
      { number: "14.22", description: "Blue wash", trigger_type: "Line", trigger_value: "Daphne." },
    );
    expect(popover()).toBeNull();
  });

  it("margin click → a position with an LX / Timecode / Visual trigger; attach an existing cue", async () => {
    const { container, placement } = setup({}, []);
    const margin = container.querySelector('[data-testid="script-margin"]') as HTMLElement;
    click(margin);
    const pop = popover() as HTMLElement;
    const trigger = pop.querySelector<HTMLSelectElement>('select[aria-label="Trigger type"]');
    expect(trigger?.value).toBe("LX");
    expect([...(trigger?.options ?? [])].map((o) => o.value)).toEqual(["LX", "Timecode", "Visual"]);
    click(button(pop, "Attach existing cue"));
    await wait(0);
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Find a cue"]');
    expect(search).not.toBeNull();
    setInputValue(search as HTMLInputElement, "14");
    await wait(150);
    const option = document.querySelector<HTMLElement>('[role="option"]');
    expect(option?.textContent).toContain("14.30");
    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await wait(10);
    expect(placement.attach).toHaveBeenCalledWith(
      "c3",
      expect.objectContaining({ offset: 0 }),
      "LX",
    );
  });

  it("read-only (viewers, older versions): no popover from selection or the margin", async () => {
    const { container } = setup({ canPlace: false }, []);
    selectIn(container, 7, 0, 7);
    await wait(30);
    click(container.querySelector('[data-testid="script-margin"]') as HTMLElement);
    expect(popover()).toBeNull();
    expect(
      container.querySelector('[data-testid="script-margin"]')?.getAttribute("data-can-place"),
    ).toBeNull();
  });

  it("Escape closes the popover", async () => {
    const { container } = setup({}, []);
    click(container.querySelector('[data-testid="script-margin"]') as HTMLElement);
    const pop = popover() as HTMLElement;
    act(() => {
      pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  it("a character name alone: offers the line they say instead", async () => {
    const { container, placement } = setup({}, []);
    selectIn(container, 4, 0, 3); // "SUE"
    await wait(30);
    const hint = document.querySelector('[data-testid="next-line-hint"]') as HTMLElement;
    expect(hint.textContent).toContain("Anchor on the following line instead?");
    click(button(hint, "Use the next line"));
    const pop = popover() as HTMLElement;
    expect(document.querySelector('[data-testid="next-line-hint"]')).toBeNull();
    click(button(pop, "New cue on this line"));
    click(button(pop, "Create cue"));
    await wait(10);
    expect(placement.create).toHaveBeenCalledWith(
      expect.objectContaining({ block: 5, offset: 0, quote: "Sweet Sue needs a sax and a bass." }),
      expect.objectContaining({ trigger_value: "Sweet Sue needs a sax and a bass." }),
    );
  });

  it("keyboard: Enter on a focused line places at it, Shift+Enter quotes it; focus returns", async () => {
    const { container, placement } = setup({}, []);
    const line = container.querySelector('[data-block="7"]') as HTMLElement;
    expect(line.getAttribute("tabindex")).toBe("-1");
    act(() => line.focus());
    press("Enter", { shift: true }, line);
    let pop = popover() as HTMLElement;
    expect(pop.textContent).toContain("Daphne. Bass. Classically trained.");
    press("Escape", {}, pop);
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(line);
    press("Enter", {}, line);
    pop = popover() as HTMLElement;
    expect(pop.querySelector('select[aria-label="Trigger type"]')).not.toBeNull();
    click(button(pop, "New cue here"));
    click(button(pop, "Create cue"));
    await wait(10);
    expect(placement.create).toHaveBeenCalledWith(
      expect.objectContaining({ block: 7, offset: 0 }),
      expect.objectContaining({ trigger_type: "LX" }),
    );
    // ↓ moves to the next line.
    act(() => line.focus());
    press("ArrowDown", {}, line);
    expect(document.activeElement).toBe(container.querySelector('[data-block="8"]'));
  });
});
