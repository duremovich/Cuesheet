// Content versions in the op engine (R10): exactly one current per content item, defaults,
// promotion on delete, the cascade when content goes, and who may write them.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Role } from "../../src/shared/api";
import { newId } from "../../src/shared/ids";
import type { Op, SnapshotResponse } from "../../src/shared/ops";
import type { MutationContext } from "../../src/worker/do/ops-engine";
import type { MutateResult } from "../../src/worker/do/ShowDO";

let seq = 0;
async function freshShow() {
  const name = `versions-${Date.now()}-${seq++}`;
  const stub = env.SHOW.get(env.SHOW.idFromName(name));
  await stub.sync(name, name);
  return stub;
}

const ctx = (role: Role = "editor", userId = "u-editor"): MutationContext => ({
  userId,
  role,
  clientId: `client-${userId}`,
});

function ok(r: MutateResult) {
  if (!r.ok) throw new Error(`mutate failed: ${r.error} (op ${r.opIndex})`);
  return r;
}

async function versions(stub: { snapshotJson(): Promise<string> }, contentId: string) {
  const snap = JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
  return snap.tables.content_versions
    .filter((v) => v.content_id === contentId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((v) => ({ version: v.version, current: v.is_current, position: v.position }));
}

const version = (id: string, contentId: string, fields: Record<string, unknown> = {}): Op => ({
  op: "create",
  table: "content_versions",
  id,
  fields: { content_id: contentId, ...fields },
});

describe("content versions", () => {
  it("the first version is current; setting another current clears the rest in one batch", async () => {
    const stub = await freshShow();
    const content = newId();
    const [v1, v2, v3] = [newId(), newId(), newId()];
    ok(await stub.mutate(ctx(), [{ op: "create", table: "content", id: content, fields: {} }]));
    ok(await stub.mutate(ctx(), [version(v1, content, { version: "V01" })]));
    expect(await versions(stub, content)).toEqual([{ version: "V01", current: true, position: 1 }]);
    ok(
      await stub.mutate(ctx(), [
        version(v2, content, { version: "V02", status: "Available", date: "2026-09-30" }),
      ]),
    );
    // Not current unless asked: V01 stays.
    expect((await versions(stub, content)).map((v) => v.current)).toEqual([true, false]);
    const r = ok(
      await stub.mutate(ctx(), [version(v3, content, { version: "V03", is_current: true })]),
    );
    // The batch carries the sibling's un-current as an explicit update.
    expect(r.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "update",
          table: "content_versions",
          id: v1,
          fields: expect.objectContaining({ is_current: false }),
        }),
      ]),
    );
    expect((await versions(stub, content)).map((v) => [v.version, v.current])).toEqual([
      ["V01", false],
      ["V02", false],
      ["V03", true],
    ]);
    ok(
      await stub.mutate(ctx(), [
        { op: "update", table: "content_versions", id: v2, fields: { is_current: true } },
      ]),
    );
    expect((await versions(stub, content)).map((v) => v.current)).toEqual([false, true, false]);
    // Other content's versions are untouched.
    const other = newId();
    ok(await stub.mutate(ctx(), [{ op: "create", table: "content", id: other, fields: {} }]));
    ok(await stub.mutate(ctx(), [version(newId(), other, { is_current: true })]));
    expect((await versions(stub, content)).map((v) => v.current)).toEqual([false, true, false]);
  });

  it("deleting the current version makes the newest remaining one current", async () => {
    const stub = await freshShow();
    const content = newId();
    const [v1, v2, v3] = [newId(), newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "content", id: content, fields: {} },
        version(v1, content, { version: "V01" }),
        version(v2, content, { version: "V02" }),
        version(v3, content, { version: "V03" }),
        { op: "update", table: "content_versions", id: v1, fields: { is_current: true } },
      ]),
    );
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "content_versions", id: v1 }]));
    expect((await versions(stub, content)).map((v) => [v.version, v.current])).toEqual([
      ["V02", false],
      ["V03", true],
    ]);
    // Deleting a non-current one changes nothing else.
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "content_versions", id: v2 }]));
    expect((await versions(stub, content)).map((v) => [v.version, v.current])).toEqual([
      ["V03", true],
    ]);
  });

  it("validates status options and the content reference; content_id can't move", async () => {
    const stub = await freshShow();
    const content = newId();
    const v = newId();
    ok(await stub.mutate(ctx(), [{ op: "create", table: "content", id: content, fields: {} }]));
    const bad = await stub.mutate(ctx(), [version(newId(), content, { status: "Nope" })]);
    expect(bad).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/not an option/),
    });
    const missing = await stub.mutate(ctx(), [version(newId(), newId())]);
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    ok(await stub.mutate(ctx(), [version(v, content, { status: "In Millumin" })]));
    const other = newId();
    ok(await stub.mutate(ctx(), [{ op: "create", table: "content", id: other, fields: {} }]));
    const moved = await stub.mutate(ctx(), [
      { op: "update", table: "content_versions", id: v, fields: { content_id: other } },
    ]);
    expect(moved).toMatchObject({ ok: false, error: expect.stringMatching(/can't be changed/) });
  });

  it("deleting content deletes its versions (explicit ops, logged); rendered_by clears", async () => {
    const stub = await freshShow();
    const content = newId();
    const person = newId();
    const [v1, v2] = [newId(), newId()];
    ok(
      await stub.mutate(ctx(), [
        { op: "create", table: "persons", id: person, fields: { name: "Casey" } },
        { op: "create", table: "content", id: content, fields: { name: "105-001-VAMP" } },
        version(v1, content, { rendered_by: person }),
        version(v2, content, { rendered_by: person }),
      ]),
    );
    ok(await stub.mutate(ctx(), [{ op: "delete", table: "persons", id: person }]));
    let snap = JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
    expect(snap.tables.content_versions.map((v) => v.rendered_by)).toEqual([null, null]);
    const r = ok(await stub.mutate(ctx(), [{ op: "delete", table: "content", id: content }]));
    expect(r.ops.map((o) => [o.op, o.table])).toEqual([
      ["delete", "content_versions"],
      ["delete", "content_versions"],
      ["delete", "content"],
    ]);
    snap = JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
    expect(snap.tables.content_versions).toHaveLength(0);
    const hist = await stub.history({ table: "content_versions", id: v1 });
    expect(hist.map((h) => h.field)).toEqual(["*", "rendered_by", "*"]);
  });

  it("only editors and the owner write versions", async () => {
    const stub = await freshShow();
    const content = newId();
    ok(await stub.mutate(ctx(), [{ op: "create", table: "content", id: content, fields: {} }]));
    for (const role of ["commenter", "viewer"] as const) {
      const r = await stub.mutate(ctx(role, `u-${role}`), [version(newId(), content)]);
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    ok(await stub.mutate(ctx("owner", "u-owner"), [version(newId(), content)]));
  });
});
