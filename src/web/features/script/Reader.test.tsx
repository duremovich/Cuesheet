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
    cueOrder: [...cues.keys()],
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
  it("stacks markers that share a block, one below the other, by their measured height", () => {
    // jsdom has no layout: blocks measure at the top (0); a marker's height is what it
    // renders at (a long callout wraps and grows it), here c1's is 90 px, the others' 44.
    const base = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testid === "script-marker") return this.dataset.cue === "c1" ? 90 : 44;
        return base?.get?.call(this) ?? 0;
      },
    });
    try {
      const { container } = setup();
      const m = markers(container);
      expect(m.map((x) => x.dataset.cue)).toEqual(["c1", "c2", "c3"]);
      const tops = m.map((x) => Number.parseFloat(x.style.top));
      expect(tops).toEqual([0, 90 + MARKER_GAP, 90 + MARKER_HEIGHT + 2 * MARKER_GAP]);
    } finally {
      if (base) Object.defineProperty(HTMLElement.prototype, "offsetHeight", base);
    }
  });

  it("shows the cue number, a reference badge and the callout", () => {
    const { container } = setup();
    const m = markers(container);
    expect(m[0]?.textContent).toContain("Q 14.20");
    // The bare trigger type is the underline's / tick's job; a reference (LX 117) stays.
    expect(m[0]?.textContent).not.toContain("LINE");
    expect(m[0]?.textContent).toContain("“Sweet Sue”");
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

describe("Reader navigator", () => {
  const nav = (el: HTMLElement) =>
    el.querySelector('[data-testid="script-navigator"]') as HTMLElement;
  const rows = (el: HTMLElement) => [
    ...nav(el).querySelectorAll<HTMLElement>('[data-testid="nav-cue"]'),
  ];
  const withUnplaced = new Map([
    ...cues,
    ["c4", cueRow({ id: "c4", number: "15", sm_call: "[GO 15]", description: "Blackout" })],
    ["s1", cueRow({ id: "s1", number: null, is_section: true, description: "ACT 2" })],
  ]);
  const order = ["c2", "c1", "s1", "c3", "c4"];

  it("has no page grid: a go-to-page field instead", () => {
    const { container } = setup();
    expect(nav(container).querySelector('button[aria-label^="Page "]')).toBeNull();
    expect(nav(container).textContent).not.toContain("Pages");
    expect(nav(container).querySelector('input[aria-label="Jump to page"]')).not.toBeNull();
  });

  it("the go-to-page field jumps by label, or says there's no such page", () => {
    const { container } = setup();
    const current = () => container.querySelector('[data-testid="current-page"]')?.textContent;
    const input = nav(container).querySelector(
      'input[aria-label="Jump to page"]',
    ) as HTMLInputElement;
    const form = input.closest("form") as HTMLFormElement;
    const submit = () =>
      act(() => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    expect(current()).toBe("12");
    setInputValue(input, "99");
    submit();
    expect(nav(container).querySelector('[role="alert"]')?.textContent).toBe('No page "99"');
    setInputValue(input, "13");
    expect(nav(container).querySelector('[role="alert"]')).toBeNull();
    submit();
    expect(current()).toBe("13");
    expect(input.value).toBe("");
  });

  it("lists the cues in show order with the page they're on; sections skipped", () => {
    const { container } = setup({ cues: withUnplaced, cueOrder: order });
    const r = rows(container);
    expect(r.map((x) => x.dataset.cue)).toEqual(["c2", "c1", "c3", "c4"]);
    expect(r[1]?.textContent).toBe("14.20“Sweet Sue”12");
    expect(r[0]?.title).toContain("Q 14.25");
    // Not placed on this version: muted, no page, and says so on hover.
    expect(r[3]?.dataset.placed).toBe("false");
    expect(r[3]?.textContent).toBe("15GO 15—");
    expect(r[3]?.title).toContain("Not placed in this version of the script");
    expect(nav(container).textContent).toContain("Cues (4)");
  });

  it("clicking a cue asks the parent to show it (placed or not)", () => {
    const onFocusCue = vi.fn();
    const { container } = setup({ cues: withUnplaced, cueOrder: order, onFocusCue });
    click(rows(container)[1] as HTMLElement);
    expect(onFocusCue).toHaveBeenLastCalledWith("c1");
    click(rows(container)[3] as HTMLElement);
    expect(onFocusCue).toHaveBeenLastCalledWith("c4");
  });

  it("follows the marker filter", () => {
    const { container } = setup({
      cues: withUnplaced,
      cueOrder: order,
      filter: { ...NO_FILTER, status: "Cued" },
    });
    expect(rows(container).map((x) => x.dataset.cue)).toEqual(["c3"]);
  });

  it("highlights the cues on the page being read, and the panel's cue", () => {
    const { container } = setup({
      cues: withUnplaced,
      cueOrder: order,
      activeCue: "c3",
      anchors: [
        anchorRow({ id: "a1", cue_id: "c1", block: 5 }),
        anchorRow({ id: "a2", cue_id: "c2", block: 7, page: 2 }),
        anchorRow({ id: "a3", cue_id: "c3", block: 3 }),
      ],
    });
    const here = () => rows(container).filter((x) => x.dataset.here === "true");
    expect(here().map((x) => x.dataset.cue)).toEqual(["c1", "c3"]);
    expect(rows(container).find((x) => x.dataset.cue === "c2")?.textContent).toContain("13");
    expect(
      rows(container)
        .filter((x) => x.getAttribute("aria-current") === "true")
        .map((x) => x.dataset.cue),
    ).toEqual(["c3"]);
    press("j", {}, document.body);
    expect(here().map((x) => x.dataset.cue)).toEqual(["c2"]);
  });

  it("the header's page opens the go-to bar", () => {
    const { container } = setup();
    const header = container.querySelector('[data-testid="script-page-header"]') as HTMLElement;
    click(header.querySelector('button[title="Go to a page (g)"]') as HTMLElement);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Go to page");
  });
});
