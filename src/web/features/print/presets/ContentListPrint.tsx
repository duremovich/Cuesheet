// Content list (R21): `/shows/:id/print/content?preset=content` — every content item in
// show order, grouped by scene: a small thumbnail, name, current version, status, scene,
// cues and surfaces.
import { useMemo } from "react";
import { attachmentUrl, thumbnailUrl } from "../../../../shared/attachments";
import { groupByScene, reverseJoin, sceneTitle } from "../../../lib/show-selectors";
import { type ShowState, useShowStore } from "../../../lib/show-store";
import { hasThumbnail, thumbnailOf } from "../../attachments/selectors";
import { currentVersions } from "../../content/versions";
import { useWorkspace } from "../../show/workspace";
import styles from "../Print.module.css";
import { PrintShell, printDate, useOrientation } from "../PrintShell";

const selectState = (s: ShowState) => s;

export function ContentListPrint() {
  const ws = useWorkspace();
  const state = useShowStore(selectState);
  const [orientation, setOrientation] = useOrientation("landscape");
  const { tables, order, joins } = state;
  const groups = useMemo(() => {
    const versions = currentVersions(tables.content_versions);
    const cuesByContent = reverseJoin(joins.cueContent);
    const rows = order.content.flatMap((id) => {
      const content = tables.content.get(id);
      if (!content) return [];
      const cueIds = cuesByContent.get(id) ?? [];
      return [
        {
          content,
          version: versions.get(id)?.version ?? "",
          cues: cueIds.flatMap((c) => tables.cues.get(c)?.number ?? []).join(", "),
          surfaces: (joins.contentSurfaces.get(id) ?? [])
            .flatMap((s) => tables.surfaces.get(s)?.name ?? [])
            .join(", "),
          thumb: thumbnailOf(tables.attachments, "content", id),
        },
      ];
    });
    const scenes = order.scenes.flatMap((id) => tables.scenes.get(id) ?? []);
    return groupByScene(scenes, rows, (r) => r.content.scene_id);
  }, [tables, order, joins]);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <PrintShell
      title="Content list"
      back={`/shows/${encodeURIComponent(ws.showId)}/content`}
      testId="print-content"
      orientation={orientation}
      onOrientation={setOrientation}
      running={{
        title: `${ws.showName} · Content list`,
        footer: `${ws.showName} · ${printDate()}`,
      }}
      subtitle={
        <span>
          {count} content {count === 1 ? "item" : "items"}
        </span>
      }
    >
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <table key={g.id} className={styles.table} data-testid="print-group">
            <thead>
              <tr className={styles.groupRow}>
                <th colSpan={7}>
                  {sceneTitle(g.scene)}
                  <span className={styles.groupSub}> ({g.rows.length})</span>
                </th>
              </tr>
              <tr>
                <th scope="col" className={styles.thumbCell}>
                  <span className={styles.srOnly}>Thumbnail</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col" data-nowrap="">
                  Version
                </th>
                <th scope="col">Status</th>
                <th scope="col">Scene</th>
                <th scope="col">Cues</th>
                <th scope="col">Surfaces</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.content.id} data-testid="print-row">
                  <td className={styles.thumbCell}>
                    {r.thumb && (
                      <img
                        src={
                          hasThumbnail(r.thumb)
                            ? thumbnailUrl(ws.showId, r.thumb.id)
                            : attachmentUrl(ws.showId, r.thumb.id)
                        }
                        alt=""
                        loading="eager"
                      />
                    )}
                  </td>
                  <td>{r.content.name}</td>
                  <td data-nowrap="">{r.version}</td>
                  <td>{r.content.status ?? ""}</td>
                  <td>{g.scene ? sceneTitle(g.scene) : ""}</td>
                  <td>{r.cues}</td>
                  <td>{r.surfaces}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {count === 0 && <p className="muted">No content yet.</p>}
    </PrintShell>
  );
}
