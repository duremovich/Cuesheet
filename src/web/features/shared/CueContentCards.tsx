// The cue panel's Content tab: linked content as cards (name, status, scene), unlink, and
// "+ Add content" through the same find-or-create picker as the grid (R5a).
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chip, RecordPicker } from "../../components/grid";
import { sceneTitle } from "../../lib/show-selectors";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { rowUrl } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import { createContent, searchContent } from "./pickers";
import styles from "./RowPanel.module.css";

const NONE: string[] = [];

export function CueContentCards({ cueId }: { cueId: string }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const ids = useShowStore((s) => s.joins.cueContent.get(cueId) ?? NONE);
  const content = useShowStore((s) => s.tables.content);
  const scenes = useShowStore((s) => s.tables.scenes);
  const cue = useShowStore((s) => s.tables.cues.get(cueId));
  const statusOptions = useShowStore((s) => s.fieldOptions["content.status"]);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const items = useMemo(() => ids.flatMap((id) => content.get(id) ?? []), [ids, content]);

  const send = (ops: Parameters<typeof store.mutate>[0], what: string) =>
    store.mutate(ops).catch((e: unknown) => ws.reportError(e, what));

  return (
    <>
      {items.length === 0 ? (
        <p className="muted">No content linked.</p>
      ) : (
        <ul className={styles.cards} aria-label="Linked content">
          {items.map((c) => {
            const scene = c.scene_id ? scenes.get(c.scene_id) : undefined;
            const status = statusOptions?.find((o) => o.value === c.status);
            return (
              <li key={c.id} className={styles.card} data-testid="content-card">
                <div className={styles.cardMain}>
                  <Link className={styles.cardName} to={rowUrl(ws.showId, "content", c.id)}>
                    {c.name || "(unnamed content)"}
                  </Link>
                  <div className={styles.cardMeta}>
                    {c.status && <Chip label={c.status} color={status?.color ?? "gray"} />}
                    <span>{scene ? sceneTitle(scene) : "No scene"}</span>
                  </div>
                </div>
                {ws.canEdit && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={`Unlink ${c.name ?? "content"}`}
                    title="Unlink from this cue"
                    onClick={() =>
                      void send(
                        [
                          {
                            op: "unlink",
                            table: "cues",
                            id: cueId,
                            field: "content",
                            targetId: c.id,
                          },
                        ],
                        "unlink the content",
                      )
                    }
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ws.canEdit && (
        <button
          type="button"
          ref={addRef}
          className={styles.addButton}
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
        >
          + Add content
        </button>
      )}
      {adding && (
        <RecordPicker
          anchor={addRef.current}
          label="Content: search"
          placeholder="Find or create…"
          selectedIds={ids}
          search={(q) => searchContent(store.getState(), q, cue?.scene_id ?? null)}
          create={(name) => createContent(store, name, cue?.scene_id ?? null)}
          onPick={(item) => {
            setAdding(false);
            addRef.current?.focus();
            if (ids.includes(item.id)) return;
            void send(
              [
                {
                  op: "link",
                  table: "cues",
                  id: cueId,
                  field: "content",
                  targetId: item.id,
                  position: ids.length,
                },
              ],
              "link the content",
            );
          }}
          onClose={() => {
            setAdding(false);
            addRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
