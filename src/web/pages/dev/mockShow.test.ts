import { describe, expect, it } from "vitest";
import {
  contentSceneNumber,
  cueNumberHints,
  MockShowStore,
  seedFromExamples,
  stressSeed,
  suggestCueNumber,
} from "./mockShow";

describe("mock show seed", () => {
  const seed = seedFromExamples();

  it("parses the example cue list, scenes, content and people", () => {
    expect(seed.cues.filter((c) => !c.isSection)).toHaveLength(122);
    expect(seed.cues.filter((c) => c.isSection).map((c) => c.description)).toEqual([
      "INTERMISSION",
    ]);
    expect(seed.scenes).toHaveLength(28);
    expect(seed.people.some((p) => p.name === "Casey Brennan")).toBe(true);
    // Show order follows the CSV.
    expect(seed.cues.slice(0, 3).map((c) => c.number)).toEqual(["0.10", "0.30", "0.80"]);
  });

  it("derives a cue's scene from its first linked content", () => {
    expect(contentSceneNumber("S100 - OVERTURE", "101-001-OVERTURETHIRSTYFOR")).toBe("100");
    expect(contentSceneNumber("", "105-001-VAMP")).toBe("105");
    expect(contentSceneNumber("", "nothing USC")).toBeNull();
    const cue = (n: string) => seed.cues.find((c) => c.number === n);
    expect(cue("2.00")?.sceneId).toBe("s100");
    expect(cue("14.00")?.sceneId).toBe("s105");
    // No content, or content outside the breakdown (800-series): Unassigned.
    expect(cue("2.10")?.sceneId).toBeNull();
    expect(cue("36.00")?.sceneId).toBeNull();
  });

  it("builds a stress seed", () => {
    const big = stressSeed(seed, 5000);
    expect(big.cues).toHaveLength(5000);
    expect(big.cues.at(-1)?.number).toBe("5000");
  });
});

describe("MockShowStore", () => {
  it("inserts between neighbors and moves across groups with fractional keys", () => {
    const store = new MockShowStore(seedFromExamples());
    const list = store.list();
    const [a, b] = [list[0], list[1]];
    if (!a || !b) throw new Error("seed empty");
    const id = store.insert({ afterRowId: a.id });
    expect(
      store
        .list()
        .map((c) => c.id)
        .slice(0, 3),
    ).toEqual([a.id, id, b.id]);

    const vamp = store.list().find((c) => c.number === "14.00");
    if (!vamp) throw new Error("no 14.00");
    store.move(id, { beforeRowId: vamp.id, groupId: "s105" });
    const g = store.groups().find((x) => x.id === "s105");
    const ids = g?.rows.map((c) => c.id) ?? [];
    expect(ids.indexOf(id)).toBe(ids.indexOf(vamp.id) - 1);
    expect(store.get(id)?.sceneId).toBe("s105");

    store.move(id, { groupId: "unassigned" });
    expect(store.groups()[0]?.rows.at(-1)?.id).toBe(id);
    expect(store.get(id)?.sceneId).toBeNull();
  });

  it("creates content that search then finds, same scene first", async () => {
    const store = new MockShowStore(seedFromExamples());
    const item = await store.createContent("999-001-NEWTHING");
    expect(store.searchContent("newthing").map((c) => c.id)).toContain(item.id);
    const inScene = await store.createContent("105-009-THING", "s105");
    expect(store.searchContent("thing", "s105")[0]?.id).toBe(inScene.id);
    // Without a scene, plain list order: the earlier-created item comes first.
    const plain = store.searchContent("thing").map((c) => c.id);
    expect(plain.indexOf(item.id)).toBeLessThan(plain.indexOf(inScene.id));
  });
});

describe("cue number hints", () => {
  it("suggests the midpoint number", () => {
    expect(suggestCueNumber("14.2", "14.4")).toBe("14.3");
    expect(suggestCueNumber("14.2", "14.25")).toBe("14.22");
    expect(suggestCueNumber("70.00", undefined)).toBe("71");
    expect(suggestCueNumber("1", "2")).toBe("1.5");
  });
  it("flags duplicates in the example cue list", () => {
    const hints = cueNumberHints(seedFromExamples().cues);
    const warned = [...hints.values()].filter((h) => h.warning).map((h) => h.warning);
    expect(warned).toContain("Duplicate cue number 49.00");
  });
});
