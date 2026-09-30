import { describe, expect, it } from "vitest";
import { render } from "../../test/dom";
import { rangeToSpan, textOffsetIn } from "./placement";
import { BlockText } from "./ScriptBlocks";

const block = (i: number, text: string) => ({ i, page: 1, kind: "dialogue" as const, text });

function mount() {
  return render(
    <div>
      <BlockText
        block={block(4, "Ladies, on the train! Sweet Sue needs a sax.")}
        quotes={[{ id: "q", start: 22, end: 31 }]}
      >
        <button type="button">Q 1</button>
      </BlockText>
      <BlockText block={block(5, "Then Sweet Sue is in luck.")} />
    </div>,
  ).container;
}

function textNodes(el: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) out.push(w.currentNode as Text);
  return out;
}

describe("rangeToSpan (selection → anchor span)", () => {
  it("measures offsets in the block's own text across underline segments", () => {
    const c = mount();
    const text = c.querySelector('[data-block="4"] [data-text]') as HTMLElement;
    const [before, quoted, after] = textNodes(text);
    expect(quoted?.data).toBe("Sweet Sue");
    const r = document.createRange();
    r.setStart(before as Text, 12); // "the train!…"
    r.setEnd(after as Text, 6); // " needs"
    expect(rangeToSpan(r)).toEqual({ block: 4, offset: 12, length: 25 });
    expect(textOffsetIn(text, after as Text, 0)).toBe(31);
  });

  it("trims whitespace and cuts a selection spanning blocks at the first block's end", () => {
    const c = mount();
    const first = textNodes(c.querySelector('[data-block="4"] [data-text]') as Element);
    const second = textNodes(c.querySelector('[data-block="5"] [data-text]') as Element);
    const r = document.createRange();
    r.setStart(first[2] as Text, 0); // " needs a sax."
    r.setEnd(second[0] as Text, 4);
    expect(rangeToSpan(r)).toEqual({ block: 4, offset: 32, length: 12 });
  });

  it("ignores selections outside script text or of whitespace only", () => {
    const c = mount();
    const btn = c.querySelector("button") as HTMLElement;
    const r = document.createRange();
    r.selectNodeContents(btn);
    // A badge inside the block: counts from the start of the block's text.
    expect(rangeToSpan(r)).toEqual({ block: 4, offset: 0, length: 44 });
    const outside = document.createElement("p");
    outside.textContent = "nope";
    document.body.append(outside);
    const r2 = document.createRange();
    r2.selectNodeContents(outside);
    expect(rangeToSpan(r2)).toBeNull();
    const first = textNodes(c.querySelector('[data-block="4"] [data-text]') as Element);
    const r3 = document.createRange();
    r3.setStart(first[0] as Text, 7);
    r3.setEnd(first[0] as Text, 8); // " "
    expect(rangeToSpan(r3)).toBeNull();
  });
});
