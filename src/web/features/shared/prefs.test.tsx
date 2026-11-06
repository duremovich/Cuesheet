import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "../../test/dom";
import { readPref, useOtherTabWrites } from "./prefs";

// A Map-backed localStorage (Node's own global one shadows jsdom's and has no methods
// without --localstorage-file).
const data = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
  clear: () => data.clear(),
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });

beforeEach(() => data.clear());

/** What a `storage` event from another tab looks like (it never fires in the writer). */
function otherTabWrites(key: string | null, area: unknown = fakeStorage) {
  const e = new Event("storage");
  Object.defineProperties(e, { key: { value: key }, storageArea: { value: area } });
  act(() => {
    window.dispatchEvent(e);
  });
}

function Probe({ k, seen }: { k: string; seen: string[] }) {
  useOtherTabWrites(k, () => seen.push(String(readPref(k, null, (_v): _v is unknown => true))));
  return null;
}

describe("useOtherTabWrites", () => {
  it("re-reads its key when another tab writes it, or clears the storage", () => {
    const seen: string[] = [];
    render(<Probe k="cuesheet.x" seen={seen} />);
    data.set("cuesheet.x", JSON.stringify("theirs"));
    otherTabWrites("cuesheet.x");
    otherTabWrites("cuesheet.other");
    otherTabWrites("cuesheet.x", {}); // sessionStorage, say
    data.clear();
    otherTabWrites(null);
    expect(seen).toEqual(["theirs", "null"]);
  });

  it("follows the key it's given", () => {
    const seen: string[] = [];
    const r = render(<Probe k="cuesheet.a" seen={seen} />);
    r.rerender(<Probe k="cuesheet.b" seen={seen} />);
    data.set("cuesheet.b", "1");
    otherTabWrites("cuesheet.a");
    otherTabWrites("cuesheet.b");
    expect(seen).toEqual(["1"]);
  });
});
