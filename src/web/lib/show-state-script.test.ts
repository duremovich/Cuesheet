// The optimistic mirror of the op engine's script rules (derived anchor pages, Cue.page,
// the current version handing over on delete). test/worker/script.test.ts covers the server.
import { describe, expect, it } from "vitest";
import type { ResolvedOp } from "../../shared/ops";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "./show-state";

const ctx = { userId: "u", now: 1000 };
const common = { custom: {}, created_at: 1, created_by: "u", updated_at: 1, updated_by: "u" };

function seed(): ShowData {
  const version = (id: string, position: number, perPage: number) => ({
    op: "create" as const,
    table: "script_versions" as const,
    id,
    fields: {
      ...common,
      script_id: "s",
      label: id,
      attachment_id: null,
      page_map: [
        { startBlock: 0, page: 1, label: "1" },
        { startBlock: perPage, page: 2, label: `2${id}` },
      ],
      stats: {},
      block_count: 20,
      position,
    },
  });
  const ops: ResolvedOp[] = [
    {
      op: "create",
      table: "scripts",
      id: "s",
      fields: { ...common, title: "S", current_version_id: "v2" },
    },
    version("v1", 1, 5),
    version("v2", 2, 10),
    {
      op: "create",
      table: "cues",
      id: "q",
      fields: { ...common, number: "1", page: null, order_key: "a0" },
    },
    {
      op: "create",
      table: "cue_anchors",
      id: "a1",
      fields: {
        ...common,
        cue_id: "q",
        script_version_id: "v1",
        block: 7,
        offset: 0,
        length: 3,
        page: 2,
        state: "matched",
      },
    },
  ];
  return applyResolved(emptyData(), ops);
}

describe("script follow-ups", () => {
  it("an anchor on the current version derives its page and sets Cue.page", () => {
    let data = seed();
    const ops = resolveLocal(
      data,
      [
        {
          op: "create",
          table: "cue_anchors",
          id: "a2",
          fields: { cue_id: "q", script_version_id: "v2", block: 12 },
        },
      ],
      ctx,
    );
    data = applyResolved(data, ops);
    expect(data.tables.cue_anchors.get("a2")).toMatchObject({
      page: 2,
      offset: 0,
      length: 0,
      state: "manual",
    });
    expect(data.tables.cues.get("q")?.page).toBe("2v2");
    // Not current: no Cue.page change.
    data = applyResolved(
      data,
      resolveLocal(
        data,
        [{ op: "update", table: "cue_anchors", id: "a1", fields: { block: 1 } }],
        ctx,
      ),
    );
    expect(data.tables.cue_anchors.get("a1")?.page).toBe(1);
    expect(data.tables.cues.get("q")?.page).toBe("2v2");
    // Missing (no position) on the current version: the cue loses its page.
    data = applyResolved(
      data,
      resolveLocal(
        data,
        [
          {
            op: "update",
            table: "cue_anchors",
            id: "a2",
            fields: { block: null, state: "missing" },
          },
        ],
        ctx,
      ),
    );
    expect(data.tables.cues.get("q")?.page).toBeNull();
  });

  it("switching the current version, and deleting it, re-derive Cue.page", () => {
    let data = seed();
    data = applyResolved(
      data,
      resolveLocal(
        data,
        [{ op: "update", table: "scripts", id: "s", fields: { current_version_id: "v1" } }],
        ctx,
      ),
    );
    expect(data.tables.cues.get("q")?.page).toBe("2v1");
    data = applyResolved(
      data,
      resolveLocal(
        data,
        [{ op: "update", table: "scripts", id: "s", fields: { current_version_id: "v2" } }],
        ctx,
      ),
    );
    data = applyResolved(
      data,
      resolveLocal(data, [{ op: "update", table: "cues", id: "q", fields: { page: "x" } }], ctx),
    );
    const del = resolveLocal(data, [{ op: "delete", table: "script_versions", id: "v2" }], ctx);
    data = applyResolved(data, del);
    expect(data.tables.scripts.get("s")?.current_version_id).toBe("v1");
    expect(data.tables.cues.get("q")?.page).toBe("2v1");
  });

  it("a missing anchor has no position", () => {
    let data = seed();
    data = applyResolved(
      data,
      resolveLocal(
        data,
        [
          {
            op: "update",
            table: "cue_anchors",
            id: "a1",
            fields: { block: null, state: "missing" },
          },
        ],
        ctx,
      ),
    );
    expect(data.tables.cue_anchors.get("a1")).toMatchObject({
      offset: null,
      length: null,
      page: null,
    });
  });
});
