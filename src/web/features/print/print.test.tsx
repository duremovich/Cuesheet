import { describe, expect, it } from "vitest";
import { render } from "../../test/dom";
import { scriptPrintUrl, scriptUrl } from "../script/links";
import { useLightTheme } from "./PrintShell";
import { printViewUrl, rowColors } from "./PrintTable";

function Light() {
  useLightTheme();
  return null;
}

describe("print layouts", () => {
  it("force the light theme while mounted and restore the previous one", () => {
    document.documentElement.dataset.theme = "dark";
    const r = render(<Light />);
    expect(document.documentElement.dataset.theme).toBe("light");
    r.unmount();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("color rows like the grid: first row rule wins, cell rules stack", () => {
    const rules = [
      { when: (n: number) => n > 1, row: "green" },
      { when: (n: number) => n > 0, row: "red", cell: { key: "a", color: "blue" } },
      { when: (n: number) => n > 2, cell: { key: "a", color: "pink" } },
    ];
    expect(rowColors(rules, 0)).toEqual({ cells: new Map() });
    const s = rowColors(rules, 3);
    expect(s.row).toBe("green");
    expect(s.cells.get("a")).toBe("pink");
  });

  it("URLs", () => {
    expect(printViewUrl("s", "cues", "v1")).toBe("/shows/s/print/cues?view=v1");
    expect(printViewUrl("s", "notes", "builtin:notes")).toBe("/shows/s/print/notes");
    expect(scriptUrl("s", "c")).toBe("/shows/s/script?cue=c");
    expect(scriptPrintUrl("s", { filter: "status=Cued" })).toBe(
      "/shows/s/script/print?filter=status%3DCued",
    );
    expect(scriptPrintUrl("s")).toBe("/shows/s/script/print");
  });
});
