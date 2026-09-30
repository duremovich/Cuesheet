// Temporary read-only cue list (M1a): cues grouped by scene, as a plain table. Replaced by
// the grid component; exists so the data layer is testable end to end.
import { useMemo } from "react";
import type { CueRow, SceneRow } from "../../shared/tables";
import { useOrderedRows, useShowStore } from "../lib/show-store";
import styles from "./CueListPlain.module.css";

export interface SceneGroup {
  scene: SceneRow | null;
  cues: CueRow[];
}

/** "Unassigned" first (only if it has cues), then every scene in show order. */
export function groupCuesByScene(scenes: SceneRow[], cues: CueRow[]): SceneGroup[] {
  const byScene = new Map<string | null, CueRow[]>();
  const known = new Set(scenes.map((s) => s.id));
  for (const cue of cues) {
    const key = cue.scene_id && known.has(cue.scene_id) ? cue.scene_id : null;
    const list = byScene.get(key) ?? [];
    list.push(cue);
    byScene.set(key, list);
  }
  const groups: SceneGroup[] = [];
  const unassigned = byScene.get(null);
  if (unassigned?.length) groups.push({ scene: null, cues: unassigned });
  for (const scene of scenes) groups.push({ scene, cues: byScene.get(scene.id) ?? [] });
  return groups;
}

export function sceneLabel(scene: SceneRow | null): string {
  if (!scene) return "Unassigned";
  return [scene.number, scene.name].filter(Boolean).join(" ") || "Untitled scene";
}

const COLUMNS = ["Cue", "Description", "Trigger / SM call", "LX", "Status", "Content", "Assignees"];

export function CueListPlain() {
  const status = useShowStore((s) => s.status);
  const error = useShowStore((s) => s.error);
  const cues = useOrderedRows("cues");
  const scenes = useOrderedRows("scenes");
  const groups = useMemo(() => groupCuesByScene(scenes, cues), [scenes, cues]);

  if (status === "loading") return <p className="muted">Loading cues…</p>;
  if (status === "error") return <p className="error">Couldn't load the show: {error}</p>;

  return (
    <div className={styles.wrap} data-testid="cue-list">
      <table className={styles.table}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        {cues.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={COLUMNS.length} className="muted">
                No cues yet.
              </td>
            </tr>
          </tbody>
        )}
        {cues.length > 0 &&
          groups.map((g) => (
            <tbody key={g.scene?.id ?? "unassigned"} data-testid="scene-group">
              <tr className={styles.sceneRow}>
                <th colSpan={COLUMNS.length} scope="rowgroup" data-testid="scene-header">
                  {sceneLabel(g.scene)}{" "}
                  <span className={styles.count}>
                    {g.cues.length} {g.cues.length === 1 ? "cue" : "cues"}
                  </span>
                </th>
              </tr>
              {g.cues.map((cue) => (
                <CueTableRow key={cue.id} cue={cue} />
              ))}
            </tbody>
          ))}
      </table>
    </div>
  );
}

function CueTableRow({ cue }: { cue: CueRow }) {
  const contentIds = useShowStore((s) => s.joins.cueContent.get(cue.id));
  const personIds = useShowStore((s) => s.joins.cueAssignees.get(cue.id));
  const content = useShowStore((s) => s.tables.content);
  const persons = useShowStore((s) => s.tables.persons);
  const statusColor = useShowStore(
    (s) => s.fieldOptions["cues.status"]?.find((o) => o.value === cue.status)?.color,
  );

  if (cue.is_section) {
    return (
      <tr className={styles.sectionRow} data-testid="cue-row" data-cue-id={cue.id}>
        <td colSpan={COLUMNS.length}>
          {[cue.number, cue.description, cue.sm_call].filter(Boolean).join(" · ") || "Section"}
        </td>
      </tr>
    );
  }
  return (
    <tr data-testid="cue-row" data-cue-id={cue.id}>
      <td className={styles.number} data-testid="cue-number">
        {cue.number}
      </td>
      <td>{cue.description}</td>
      <td className={styles.call}>{cue.trigger_value ?? cue.sm_call}</td>
      <td>{cue.lx_cue}</td>
      <td>
        {cue.status && (
          <span
            className={styles.chip}
            style={{
              background: `var(--option-${statusColor ?? "gray"}-bg)`,
              color: `var(--option-${statusColor ?? "gray"}-fg)`,
            }}
          >
            {cue.status}
          </span>
        )}
      </td>
      <td>{(contentIds ?? []).map((id) => content.get(id)?.name ?? "?").join(", ")}</td>
      <td>{(personIds ?? []).map((id) => persons.get(id)?.name ?? "?").join(", ")}</td>
    </tr>
  );
}
