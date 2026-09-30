import { describe, expect, it } from "vitest";
import type { ContentRow } from "../../../shared/tables";
import { contentBaseName } from "../content/contentName";
import { contentItem, parseSceneName } from "./pickers";

describe("parseSceneName", () => {
  it("splits a leading scene number from the name", () => {
    expect(parseSceneName("106A Train Platform")).toEqual({
      number: "106A",
      name: "Train Platform",
    });
    expect(parseSceneName("116 - Encore")).toEqual({ number: "116", name: "Encore" });
    expect(parseSceneName("  300 ")).toEqual({ number: "300", name: null });
    expect(parseSceneName("Curtain Call")).toEqual({ number: null, name: "Curtain Call" });
    expect(parseSceneName("3rd Street")).toEqual({ number: null, name: "3rd Street" });
  });
});

describe("content picker items", () => {
  it("carry the name without its SSS-NNN- prefix as an alias", () => {
    expect(contentBaseName("105-001-VAMP")).toBe("VAMP");
    expect(contentBaseName("LOOSE")).toBe("LOOSE");
    const item = contentItem(
      { id: "k", name: "105-001-VAMP", scene_id: null } as ContentRow,
      new Map(),
    );
    expect(item.aliases).toEqual(["VAMP"]);
    const plain = contentItem({ id: "k", name: "LOOSE", scene_id: null } as ContentRow, new Map());
    expect(plain.aliases).toBeUndefined();
  });
});
