// The mock script source (VITE_SCRIPT_MOCK=1) that stands in for M4a until it lands.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AnyOp } from "../../../shared/ops";
import type { ShowStore } from "../../lib/show-store";
import { makeAnchor } from "./contract";
import { parseScriptText } from "./mock/extractText";
import { anchorStoreOps, MockSource, mockKey } from "./source";
import { cueRow } from "./testData";

const v1 = parseScriptText(readFileSync("e2e/fixtures/script-v1.txt", "utf8"));
const v2 = parseScriptText(readFileSync("e2e/fixtures/script-v2.txt", "utf8"));

function fakeStore() {
  const cues = new Map([["c1", cueRow({ id: "c1", number: "1" })]]);
  const mutate = vi.fn(async (_ops: AnyOp[]) => undefined);
  const store = { getState: () => ({ tables: { cues } }), mutate } as unknown as ShowStore;
  return { store, mutate, cues };
}

describe("MockSource", () => {
  it("imports versions, re-anchors, keeps anchors in localStorage and sets cue pages", async () => {
    localStorage.clear();
    const { store, mutate, cues } = fakeStore();
    const src = new MockSource(store, "show1");
    const r1 = await src.importVersion({ versionId: "v1", label: "Draft", text: v1 });
    expect(r1.results).toEqual([]);
    const snap = src.getSnapshot();
    expect([...snap.scripts.values()][0]?.current_version_id).toBe("v1");
    expect(snap.versions.get("v1")).toMatchObject({ label: "Draft", page_count: 3 });

    // A new cue on page 13 + its anchor: the cue's page is set in its create.
    const b = v1.blocks.find((x) => x.text.includes("Josephine"));
    const anchor = makeAnchor(v1, b?.i ?? 0, 0, 4);
    await src.apply(
      [{ op: "create", table: "cues", id: "c2", fields: { number: "2" } }],
      [
        {
          op: "create",
          id: "a2",
          fields: {
            cue_id: "c2",
            script_version_id: "v1",
            ...anchor,
            state: "manual",
            confidence: 1,
          },
        },
      ],
    );
    expect(mutate).toHaveBeenLastCalledWith([
      { op: "create", table: "cues", id: "c2", fields: { number: "2", page: "13" } },
    ]);
    cues.set("c2", cueRow({ id: "c2", number: "2", page: "13" }));
    expect(src.getSnapshot().anchors.get("a2")).toMatchObject({ page: 2, block: b?.i });
    expect(JSON.parse(localStorage.getItem(mockKey("show1")) ?? "{}").anchors).toHaveLength(1);

    // Version 2 re-anchors it (unchanged line: matched).
    const r2 = await src.importVersion({ versionId: "v2", label: "v2", text: v2 });
    expect(r2.results.map((r) => [r.cueId, r.state])).toEqual([["c2", "matched"]]);
    const onV2 = [...src.getSnapshot().anchors.values()].filter(
      (a) => a.script_version_id === "v2",
    );
    expect(onV2).toHaveLength(1);
    expect(await src.fetchText("v2")).toBe(v2);

    // A second source (another tab) reads the same data.
    const again = new MockSource(store, "show1");
    expect(again.getSnapshot().anchors.size).toBe(2);
  });

  it("anchor ops become store ops on cue_anchors (live)", () => {
    expect(
      anchorStoreOps([
        { op: "delete", id: "a" },
        { op: "update", id: "b", fields: { state: "manual" } },
      ]),
    ).toEqual([
      { op: "delete", table: "cue_anchors", id: "a" },
      { op: "update", table: "cue_anchors", id: "b", fields: { state: "manual" } },
    ]);
  });
});
