// Temporary "Add cue" form (M1a) so create + real-time can be exercised before the grid.
import { type FormEvent, useMemo, useState } from "react";
import { newId } from "../../shared/ids";
import type { Placement } from "../../shared/ops";
import { useApiErrorHandler } from "../lib/auth";
import { useMutate, useOrderedRows } from "../lib/show-store";
import styles from "./AddCueForm.module.css";
import { sceneLabel } from "./CueListPlain";

const END = "";

export function AddCueForm() {
  const mutate = useMutate();
  const handleError = useApiErrorHandler();
  const scenes = useOrderedRows("scenes");
  const cues = useOrderedRows("cues");
  const [number, setNumber] = useState("");
  const [description, setDescription] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [afterId, setAfterId] = useState(END);
  const [error, setError] = useState<string | null>(null);

  const sceneCues = useMemo(
    () => cues.filter((c) => (c.scene_id ?? "") === sceneId),
    [cues, sceneId],
  );

  /** Right after the chosen cue, else after the scene's last cue, else at the end. */
  function placement(): Placement {
    if (afterId !== END && sceneCues.some((c) => c.id === afterId)) return { after: afterId };
    const last = sceneCues.at(-1);
    return last ? { after: last.id } : {};
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fields = {
      number: number.trim() || null,
      description: description.trim() || null,
      scene_id: sceneId || null,
    };
    const op = {
      op: "create" as const,
      table: "cues" as const,
      id: newId(),
      fields,
      ...placement(),
    };
    setNumber("");
    setDescription("");
    setAfterId(END);
    try {
      await mutate([op]);
    } catch (err) {
      setError(handleError(err));
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="Add cue">
      <h2 className={styles.title}>Add cue</h2>
      <div className={styles.fields}>
        <label>
          Number
          <input type="text" value={number} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <label className={styles.grow}>
          Description
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Scene
          <select
            value={sceneId}
            onChange={(e) => {
              setSceneId(e.target.value);
              setAfterId(END);
            }}
          >
            <option value="">Unassigned</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {sceneLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Insert after
          <select value={afterId} onChange={(e) => setAfterId(e.target.value)}>
            <option value={END}>End of scene</option>
            {sceneCues.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number ?? c.description ?? "(unnumbered)"}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          Add cue
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
