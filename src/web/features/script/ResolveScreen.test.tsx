import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShowStore } from "../../lib/show-store";
import { click, render, wait } from "../../test/dom";
import type { ScriptText } from "./contract";
import { ResolveScreen } from "./ResolveScreen";
import { type ScriptSource, ScriptSourceProvider } from "./source";
import { anchorRow, cueRow, SAMPLE } from "./testData";

const OLD: ScriptText = SAMPLE;
const NEW: ScriptText = {
  ...SAMPLE,
  blocks: SAMPLE.blocks.map((b) =>
    b.i === 5 ? { ...b, text: "Sweet Sue needs a saxophone and a bass." } : b,
  ),
};

function source(): ScriptSource {
  return {
    mode: "mock",
    subscribe: () => () => undefined,
    getSnapshot: () => ({ scripts: new Map(), versions: new Map(), anchors: new Map() }),
    apply: vi.fn(async () => undefined),
    importVersion: vi.fn(),
    setOriginal: vi.fn(),
    fetchText: vi.fn(async () => OLD),
  };
}

const cues = new Map([
  ["c1", cueRow({ id: "c1", number: "14.20", trigger_type: "Line", trigger_value: "Sweet Sue" })],
  ["c2", cueRow({ id: "c2", number: "14.25" })],
  ["c3", cueRow({ id: "c3", number: "14.30" })],
]);
const prevAnchors = [
  anchorRow({
    id: "p1",
    cue_id: "c1",
    block: 5,
    offset: 0,
    length: 9,
    quote: "Sweet Sue",
    script_version_id: "v1",
  }),
  anchorRow({
    id: "p2",
    cue_id: "c2",
    block: 7,
    offset: 0,
    length: 7,
    quote: "Daphne.",
    script_version_id: "v1",
  }),
  anchorRow({ id: "p3", cue_id: "c3", block: 8, script_version_id: "v1" }),
];
const anchors = [
  anchorRow({
    id: "n1",
    cue_id: "c1",
    block: 5,
    offset: 0,
    length: 17,
    quote: "Sweet Sue needs a",
    state: "changed",
    confidence: 0.7,
    script_version_id: "v2",
  }),
  anchorRow({ id: "n2", cue_id: "c2", state: "missing", script_version_id: "v2" }),
];

function setup(fieldOptions = { "cues.status": [{ value: "Cut", color: "red" }] } as never) {
  const onApply = vi.fn(async () => undefined);
  const onError = vi.fn();
  const onExit = vi.fn();
  const r = render(
    <ScriptSourceProvider store={{} as ShowStore} showId="s" source={source()}>
      <ResolveScreen
        versionId="v2"
        versionLabel="v2"
        prevVersionId="v1"
        text={NEW}
        cues={cues}
        fieldOptions={fieldOptions}
        results={null}
        anchors={anchors}
        prevAnchors={prevAnchors}
        onApply={onApply}
        onExit={onExit}
        onError={onError}
      />
    </ScriptSourceProvider>,
  );
  return { ...r, onApply, onError, onExit };
}

const btn = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLElement;
const heading = (c: HTMLElement) => c.querySelector("h3")?.textContent ?? "";

describe("ResolveScreen", () => {
  it("lists changed and missing cues; Accept keeps the guess as a manual anchor", async () => {
    const { container, onApply } = setup();
    await wait(0);
    const items = [...container.querySelectorAll('[data-testid="resolve-item"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Q 14.20 changed"),
      expect.stringContaining("Q 14.25 missing"),
      expect.stringContaining("Q 14.30 missing"),
    ]);
    expect(heading(container)).toContain("Line changed");
    expect(
      container.querySelector('[data-testid="resolve-old-text"] [data-quote]')?.textContent,
    ).toBe("Sweet Sue");
    expect(
      container.querySelector('[data-testid="resolve-new-text"] [data-quote]')?.textContent,
    ).toBe("Sweet Sue needs a");
    click(btn(container, "Accept"));
    await wait(0);
    expect(onApply).toHaveBeenCalledWith(
      [],
      [
        {
          op: "update",
          id: "n1",
          fields: expect.objectContaining({ block: 5, length: 17, state: "manual", confidence: 1 }),
        },
      ],
    );
    expect(heading(container)).toContain("Q 14.25");
    expect(btn(container, "Accept").hasAttribute("disabled")).toBe(true); // no guess
  });

  it("Place: select new text, then place (creates or updates the anchor)", async () => {
    const { container, onApply } = setup();
    await wait(0);
    click(
      container.querySelectorAll<HTMLElement>('[data-testid="resolve-item"]')[1] as HTMLElement,
    );
    click(btn(container, "Place"));
    expect(
      container.querySelector('[data-testid="resolve-new-text"]')?.getAttribute("data-placing"),
    ).toBe("true");
    expect(btn(container, "Select text first").hasAttribute("disabled")).toBe(true);
    // Click a line without selecting: a position at its start.
    const block = container.querySelector(
      '[data-testid="resolve-new-text"] [data-block="6"]',
    ) as HTMLElement;
    act(() => {
      block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    click(btn(container, "Place Q 14.25 here"));
    await wait(0);
    expect(onApply).toHaveBeenCalledWith(
      [],
      [
        {
          op: "update",
          id: "n2",
          fields: expect.objectContaining({ block: 6, length: 0, state: "manual" }),
        },
      ],
    );
  });

  it("Cut sets status Cut and drops the anchor; Skip changes nothing; all done at the end", async () => {
    const { container, onApply } = setup();
    await wait(0);
    click(btn(container, "Skip"));
    expect(heading(container)).toContain("Q 14.25");
    click(btn(container, "Cut"));
    await wait(0);
    expect(onApply).toHaveBeenCalledWith(
      [{ op: "update", table: "cues", id: "c2", fields: { status: "Cut" } }],
      [{ op: "delete", id: "n2" }],
    );
    // c3 had no anchor row at all: Cut is just the status.
    click(btn(container, "Cut"));
    await wait(0);
    expect(onApply).toHaveBeenLastCalledWith(
      [{ op: "update", table: "cues", id: "c3", fields: { status: "Cut" } }],
      [],
    );
    expect(container.querySelector('[data-testid="resolve-done"]')).not.toBeNull();
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("Cut without a Cut status option reports instead of writing", async () => {
    const { container, onApply, onError } = setup({} as never);
    await wait(0);
    click(btn(container, "Cut"));
    expect(onApply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("a failed write keeps the item pending", async () => {
    const { container, onApply, onError } = setup();
    onApply.mockRejectedValueOnce(new Error("nope"));
    await wait(0);
    click(btn(container, "Accept"));
    await wait(0);
    expect(onError).toHaveBeenCalled();
    expect(heading(container)).toContain("Q 14.20");
  });
});
