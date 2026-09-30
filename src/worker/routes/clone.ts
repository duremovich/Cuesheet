// Show templates / clone (R27): POST /api/shows/:id/clone {name, includeScenes?, asTemplate?}.
// Copies a show's structure into a new show: surfaces, scenes (optional), custom tables
// (definitions only), custom fields, shared views and the default unit. Never cues, notes,
// content, shots, attachments or the script. The new show's DO is written through the op
// engine (one batch per table), so its history starts with the copy.
import type { Context } from "hono";
import {
  type CloneShowRequest,
  type CloneShowResponse,
  MAX_NAME_LENGTH,
  type ShowSummaryDTO,
} from "../../shared/api";
import { customTableId, customTableRef } from "../../shared/custom-fields";
import { newId } from "../../shared/ids";
import type { AnyOp, SnapshotResponse } from "../../shared/ops";
import type { ViewRow } from "../../shared/tables";
import { schema } from "../db/d1/client";
import type { MutationContext } from "../do/ops-engine";
import type { ShowEnv } from "./shows";
import { showStub } from "./shows";
import { readJsonObject, str } from "./util";

type C = Context<ShowEnv>;

/** Batches stay well under the mutate limit. */
const MAX_BATCH = 1000;

/** Replace every string in a JSON value that is a key of `ids` (record ids in view configs). */
function remapIds(v: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") return ids.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remapIds(x, ids));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [ids.get(k) ?? k, remapIds(x, ids)]),
    );
  }
  return v;
}

/** The ops that copy `snap`'s structure, one list per table (applied in this order). */
export function cloneOps(
  snap: SnapshotResponse,
  opts: { includeScenes: boolean },
): { batches: AnyOp[][]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const idFor = (old: string) => {
    let id = ids.get(old);
    if (!id) {
      id = newId();
      ids.set(old, id);
    }
    return id;
  };
  const batches: AnyOp[][] = [];
  const t = snap.tables;

  if (snap.meta.default_unit) {
    batches.push([{ op: "meta", fields: { default_unit: snap.meta.default_unit } }]);
  }

  // Surfaces (regions' parents set after every surface exists).
  const surfaces: AnyOp[] = [];
  for (const s of t.surfaces) {
    surfaces.push({
      op: "create",
      table: "surfaces",
      id: idFor(s.id),
      fields: {
        name: s.name,
        channel: s.channel,
        width: s.width,
        height: s.height,
        pixel_width: s.pixel_width,
        pixel_height: s.pixel_height,
        throw_distance: s.throw_distance,
        lens_ratio: s.lens_ratio,
        description: s.description,
      },
    });
  }
  for (const s of t.surfaces) {
    if (s.parent_id && ids.has(s.parent_id)) {
      surfaces.push({
        op: "update",
        table: "surfaces",
        id: idFor(s.id),
        fields: { parent_id: idFor(s.parent_id) },
      });
    }
  }
  batches.push(surfaces);

  if (opts.includeScenes) {
    const scenes: AnyOp[] = [];
    for (const s of t.scenes) {
      scenes.push({
        op: "create",
        table: "scenes",
        id: idFor(s.id),
        fields: {
          number: s.number,
          name: s.name,
          act: s.act,
          location: s.location,
          time_of_day: s.time_of_day,
          song: s.song,
          stage_direction: s.stage_direction,
          description: s.description,
          video_overview: s.video_overview,
        },
      });
      for (const surfaceId of snap.joins.sceneSurfaces[s.id] ?? []) {
        if (!ids.has(surfaceId)) continue;
        scenes.push({
          op: "link",
          table: "scenes",
          id: idFor(s.id),
          field: "surfaces",
          targetId: idFor(surfaceId),
        });
      }
    }
    batches.push(scenes);
  }

  // Custom tables (definitions only), then every custom field (targets remapped).
  const tables: AnyOp[] = t.custom_tables.map((ct) => ({
    op: "create",
    table: "custom_tables",
    id: idFor(ct.id),
    fields: {
      key: ct.key,
      label: ct.label,
      icon: ct.icon,
      position: ct.position,
      primary_field_key: ct.primary_field_key,
    },
  }));
  batches.push(tables);
  const mapTable = (table: string) => {
    const ct = customTableId(table);
    return ct ? (ids.has(ct) ? customTableRef(idFor(ct)) : null) : table;
  };
  const fields: AnyOp[] = [];
  for (const f of t.custom_fields) {
    const table = mapTable(f.table);
    if (!table) continue;
    const options = { ...f.options };
    if (options.target) {
      const target = mapTable(options.target);
      if (!target) continue; // a link into a table that isn't copied
      options.target = target;
    }
    fields.push({
      op: "create",
      table: "custom_fields",
      id: idFor(f.id),
      fields: {
        table,
        key: f.key,
        label: f.label,
        type: f.type,
        options,
        position: f.position,
        width: f.width,
      },
    });
  }
  batches.push(fields);

  // Shared views (personal views stay with their owners). The new show's seeded default
  // views make way for the copies of a table that has any.
  const views: AnyOp[] = [];
  const shared = t.views.filter((v) => v.owner_user_id === null);
  for (const v of shared) {
    const table = mapTable(v.table);
    if (!table) continue;
    views.push({
      op: "create",
      table: "views",
      id: idFor(v.id),
      fields: {
        table,
        name: v.name,
        is_default: v.is_default,
        position: v.position,
        config: remapIds(v.config, ids),
      },
    });
  }
  batches.push(views);
  return { batches: batches.filter((b) => b.length > 0), ids };
}

export async function cloneShow(c: C): Promise<Response> {
  if (c.var.role !== "owner" && c.var.role !== "editor") {
    return c.json({ error: "Only editors can copy a show" }, 403);
  }
  const body = (await readJsonObject(c)) as Partial<CloneShowRequest> | null;
  const name = str(body?.name).trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return c.json({ error: `Show name must be 1–${MAX_NAME_LENGTH} characters` }, 400);
  }
  const includeScenes = body?.includeScenes !== false;
  const asTemplate = body?.asTemplate === true;

  const source = showStub(c.env, c.var.show.id);
  const snap = JSON.parse(await source.snapshotJson()) as SnapshotResponse;
  const { batches } = cloneOps(snap, { includeScenes });

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const userId = c.var.user.id;
  await c.var.db.batch([
    c.var.db
      .insert(schema.shows)
      .values({ id, name, createdBy: userId, createdAt, isTemplate: asTemplate }),
    c.var.db.insert(schema.memberships).values({ showId: id, userId, role: "owner", createdAt }),
  ]);
  const target = showStub(c.env, id);
  await target.sync(id, name);
  const ctx: MutationContext = { userId, role: "owner", clientId: null };
  // The seeded default views of tables that get copied views: removed after the copies.
  const copiedTables = new Set(
    snap.tables.views.filter((v) => v.owner_user_id === null).map((v) => v.table as string),
  );
  const seeded = (JSON.parse(await target.snapshotJson()) as SnapshotResponse).tables.views;
  const drop: AnyOp[] = seeded
    .filter((v: ViewRow) => copiedTables.has(v.table))
    .map((v) => ({ op: "delete", table: "views", id: v.id }));
  for (const batch of [...batches, drop]) {
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      const res = await target.mutate(ctx, batch.slice(i, i + MAX_BATCH));
      if (!res.ok) {
        return c.json({ error: `Copy failed: ${res.error}`, opIndex: res.opIndex }, 500);
      }
    }
  }
  const show: ShowSummaryDTO = { id, name, role: "owner", createdAt, isTemplate: asTemplate };
  return c.json({ show } satisfies CloneShowResponse, 201);
}
