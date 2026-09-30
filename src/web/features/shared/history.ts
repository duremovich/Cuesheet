// The row panel's History tab (R15): change-log entries from GET /history turned into
// "who changed what: from → to, when" lines. Pure, so it's unit-tested.
import type { HistoryEntry } from "../../../shared/ops";
import { fieldSpec, linkSpec, type TableName } from "../../../shared/tables";
import { formatLength, formatPixelSize, isPixelSize, type Unit } from "../../../shared/units";
import { sceneTitle } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import { customRowLabel } from "../custom/model";

export interface HistoryLine {
  key: string;
  who: string;
  when: number;
  kind: "created" | "deleted" | "changed" | "linked" | "unlinked" | "moved";
  /** Field label ("Description"); "" for created/deleted/moved. */
  field: string;
  from: string;
  to: string;
}

/** Storage field → the panel's label for it (column titles), with a readable fallback. */
export type FieldLabels = Partial<Record<string, string>>;

/** Column keys that differ from the storage field they edit. */
const COLUMN_KEY: Record<string, string> = {
  scene_id: "scene",
  content_id: "content",
  creator_id: "creator",
};

export function fieldLabel(field: string, labels: FieldLabels): string {
  const custom = field.startsWith("custom.") ? field.slice(7) : null;
  const key = COLUMN_KEY[field] ?? field;
  const known = labels[key] ?? labels[field];
  if (known) return known;
  const raw = custom ?? field;
  const words = raw.replace(/_id$/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A record's display label ("Cue 14.20", a content name, a person), or "(deleted)". */
export function recordLabel(data: ShowData, table: TableName, id: string): string {
  switch (table) {
    case "cues": {
      const c = data.tables.cues.get(id);
      if (!c) return "(deleted cue)";
      return c.number ? `Cue ${c.number}` : c.description?.slice(0, 40) || "(unnumbered cue)";
    }
    case "scenes": {
      const s = data.tables.scenes.get(id);
      return s ? sceneTitle(s) : "(deleted scene)";
    }
    case "content":
      return data.tables.content.get(id)?.name || "(deleted content)";
    case "persons":
      return data.tables.persons.get(id)?.name || "(deleted person)";
    case "notes":
      return data.tables.notes.get(id)?.body?.slice(0, 40) || "(deleted note)";
    case "surfaces":
      return data.tables.surfaces.get(id)?.name || "(deleted surface)";
    case "views":
      return data.tables.views.get(id)?.name || "(deleted view)";
    case "content_versions":
      return data.tables.content_versions.get(id)?.version || "(deleted version)";
    case "attachments":
      return data.tables.attachments.get(id)?.filename || "(deleted file)";
    case "scripts":
      return data.tables.scripts.get(id)?.title || "Script";
    case "script_versions":
      return data.tables.script_versions.get(id)?.label || "(deleted script version)";
    case "cue_anchors": {
      const a = data.tables.cue_anchors.get(id);
      return a ? `${recordLabel(data, "cues", a.cue_id)} in the script` : "(deleted anchor)";
    }
    case "custom_fields":
      return data.tables.custom_fields.get(id)?.label || "(deleted field)";
    case "custom_tables":
      return data.tables.custom_tables.get(id)?.label || "(deleted table)";
    case "custom_rows": {
      const r = data.tables.custom_rows.get(id);
      return r ? customRowLabel(data, r) : "(deleted row)";
    }
    case "shot_lists":
      return data.tables.shot_lists.get(id)?.name || "(deleted shot list)";
    case "shots": {
      const s = data.tables.shots.get(id);
      if (!s) return "(deleted shot)";
      return s.number ? `Shot ${s.number}` : s.description?.slice(0, 40) || "(unnumbered shot)";
    }
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function parse(v: string | null): unknown {
  if (v === null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * A stored value as text: refs resolve to labels; lengths show in `unit` (meters by
 * default), pixel sizes as w×h; empty values are "" (shown as "—").
 */
export function formatStored(
  data: ShowData,
  table: TableName,
  field: string,
  value: unknown,
  unit: Unit = "m",
): string {
  if (value === null || value === undefined || value === "") return "";
  const link = linkSpec(table, field);
  if (link && typeof value === "string") return recordLabel(data, link.to, value);
  const spec = field.startsWith("custom.") ? undefined : fieldSpec(table, field);
  if (spec?.type === "ref" && spec.ref && typeof value === "string") {
    return recordLabel(data, spec.ref, value);
  }
  if (spec?.type === "measurement" && typeof value === "number") return formatLength(value, unit);
  if (spec?.type === "pixel_size" && isPixelSize(value)) return formatPixelSize(value);
  if (field === "completed_at" && typeof value === "number") {
    return dateFormat.format(new Date(value));
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * One entry as a line. `*` entries are "created" (new only) or "deleted" (old only); link
 * fields log the target id as new (linked) or old (unlinked); `order_key` is a move.
 */
export function formatHistory(
  e: HistoryEntry,
  data: ShowData,
  labels: FieldLabels,
  memberNames?: ReadonlyMap<string, string>,
  /** The active measurement unit (lengths are stored in meters). */
  unit: Unit = "m",
): HistoryLine {
  const who = e.userName ?? memberNames?.get(e.userId) ?? "Someone";
  const base = {
    key: `${e.version}:${e.field}:${e.old ?? ""}:${e.new ?? ""}`,
    who,
    when: e.ts,
  };
  if (e.field === "*") {
    return { ...base, kind: e.new === null ? "deleted" : "created", field: "", from: "", to: "" };
  }
  if (e.field === "order_key") return { ...base, kind: "moved", field: "", from: "", to: "" };
  const oldV = parse(e.old);
  const newV = parse(e.new);
  const field = fieldLabel(e.field, labels);
  if (linkSpec(e.table, e.field)) {
    const linked = newV !== null;
    return {
      ...base,
      kind: linked ? "linked" : "unlinked",
      field,
      from: "",
      to: formatStored(data, e.table, e.field, linked ? newV : oldV),
    };
  }
  return {
    ...base,
    kind: "changed",
    field,
    from: formatStored(data, e.table, e.field, oldV, unit),
    to: formatStored(data, e.table, e.field, newV, unit),
  };
}

/** The sentence for a line, for screen readers and tests ("Ada changed Description: a → b"). */
export function historySentence(l: HistoryLine): string {
  switch (l.kind) {
    case "created":
      return `${l.who} created this`;
    case "deleted":
      return `${l.who} deleted this`;
    case "moved":
      return `${l.who} moved this`;
    case "linked":
      return `${l.who} linked ${l.field}: ${l.to}`;
    case "unlinked":
      return `${l.who} unlinked ${l.field}: ${l.to}`;
    default:
      return `${l.who} changed ${l.field}: ${l.from || "—"} → ${l.to || "—"}`;
  }
}

/** Fields not worth a history line (maintained automatically). */
export const HIDDEN_HISTORY_FIELDS = new Set(["updated_at", "updated_by"]);
