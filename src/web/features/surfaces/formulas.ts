// Built-in computed columns on Surfaces (R12), written in the formula language
// (src/shared/formula) and evaluated per row on the client. A surface reads as a formula
// record: its fields (lengths as quantities), `pixels` ({w, h}), and its links `parent`,
// `regions`, `scenes`, `content` (record sets).
import {
  compile,
  type FormulaRecord,
  qty,
  type RecordSet,
  run,
  type Value,
} from "../../../shared/formula";
import type { SurfaceRow } from "../../../shared/tables";
import { sceneTitle } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";

/** Key → formula, in column order. `resultType` drives filters and sorting. */
export const SURFACE_FORMULAS = {
  ppi: { title: "PPI", source: "PPI(pixel_width, width)", resultType: "number" },
  pixel_pitch: {
    title: "Pitch (mm)",
    source: "PITCH(width, pixel_width)",
    resultType: "number",
  },
  aspect_ratio: {
    title: "Aspect",
    source:
      "IF(AND(pixel_width, pixel_height), ASPECT(pixel_width, pixel_height), ASPECT(width, height))",
    resultType: "text",
  },
  throw_width: {
    title: "Image width",
    source: "throw_distance / lens_ratio",
    resultType: "measurement",
  },
} as const;

export type SurfaceFormulaKey = keyof typeof SURFACE_FORMULAS;
export type SurfaceComputed = Record<SurfaceFormulaKey, Value>;

const COMPILED = Object.fromEntries(
  Object.entries(SURFACE_FORMULAS).map(([k, f]) => [k, compile(f.source)]),
) as Record<SurfaceFormulaKey, ReturnType<typeof compile>>;

const len = (m: number | null): Value => (m === null ? null : qty(m));

/** A plain record over some fields (for linked scenes/content). */
function plainRecord(label: string, fields: Record<string, Value>): FormulaRecord {
  return {
    label,
    get: (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined),
  };
}

/**
 * A surface as a formula record. `depth` bounds how far `parent.parent…` goes (the engine
 * forbids cycles, but a stale client state could briefly hold one).
 */
export function surfaceRecord(data: ShowData, s: SurfaceRow, depth = 0): FormulaRecord {
  const set = (records: FormulaRecord[]): RecordSet => ({ records });
  return {
    label: s.name ?? "",
    get(name: string): Value | RecordSet | undefined {
      switch (name) {
        case "name":
        case "channel":
        case "description":
          return s[name];
        case "width":
        case "height":
        case "throw_distance":
          return len(s[name]);
        case "pixel_width":
        case "pixel_height":
        case "lens_ratio":
          return s[name];
        case "pixels":
          return s.pixel_width && s.pixel_height ? { w: s.pixel_width, h: s.pixel_height } : null;
        case "parent": {
          const p = s.parent_id ? data.tables.surfaces.get(s.parent_id) : undefined;
          return set(p && depth < 16 ? [surfaceRecord(data, p, depth + 1)] : []);
        }
        case "regions": {
          if (depth >= 16) return set([]);
          const kids = data.order.surfaces
            .map((id) => data.tables.surfaces.get(id))
            .filter((x): x is SurfaceRow => !!x && x.parent_id === s.id);
          return set(kids.map((k) => surfaceRecord(data, k, depth + 1)));
        }
        case "scenes": {
          const ids = new Set<string>();
          for (const [scene, targets] of data.joins.sceneSurfaces) {
            if (targets.includes(s.id)) ids.add(scene);
          }
          return set(
            data.order.scenes
              .filter((id) => ids.has(id))
              .flatMap((id) => {
                const sc = data.tables.scenes.get(id);
                return sc
                  ? [plainRecord(sceneTitle(sc), { number: sc.number, name: sc.name })]
                  : [];
              }),
          );
        }
        case "content": {
          const ids = new Set<string>();
          for (const [c, targets] of data.joins.contentSurfaces) {
            if (targets.includes(s.id)) ids.add(c);
          }
          return set(
            data.order.content
              .filter((id) => ids.has(id))
              .flatMap((id) => {
                const c = data.tables.content.get(id);
                return c ? [plainRecord(c.name ?? "", { name: c.name, status: c.status })] : [];
              }),
          );
        }
        default:
          return undefined;
      }
    },
  };
}

/** Every built-in formula for one surface. */
export function computeSurface(data: ShowData, s: SurfaceRow): SurfaceComputed {
  const rec = surfaceRecord(data, s);
  const out = {} as SurfaceComputed;
  for (const k of Object.keys(COMPILED) as SurfaceFormulaKey[]) out[k] = run(COMPILED[k], rec);
  return out;
}
