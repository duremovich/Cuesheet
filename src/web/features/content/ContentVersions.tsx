// The content panel's Versions tab (R10; ux.md §Detail panel): the item's versions newest
// first, "Add version" (next Vnn, today, you, Available, current), set current, edit in
// place (Enter or leaving a field saves, Escape reverts), delete with Undo. Editors only;
// everyone else reads.
import { useMemo, useState } from "react";
import type { Op } from "../../../shared/ops";
import type { ContentVersionRow, FieldOption } from "../../../shared/tables";
import { Chip } from "../../components/grid";
import { optionColor } from "../../components/grid/Chip";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import styles from "../shared/RowPanel.module.css";
import { useWorkspace } from "../show/workspace";
import vstyles from "./ContentVersions.module.css";
import { addVersionOps, restoreVersionOps, versionsOf } from "./versions";

const NO_OPTIONS: FieldOption[] = [];
const UNDO_MS = 8000;

export function ContentVersions({ contentId }: { contentId: string }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const all = useShowStore((s) => s.tables.content_versions);
  const persons = useShowStore((s) => s.tables.persons);
  const statusOptions = useShowStore(
    (s) => s.fieldOptions["content_versions.status"] ?? NO_OPTIONS,
  );
  const versions = useMemo(() => versionsOf(all, contentId), [all, contentId]);
  const people = useMemo(
    () => [...persons.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [persons],
  );
  const canEdit = ws.canEdit;

  const send = (ops: Op[], what: string) =>
    store.mutate(ops).catch((e: unknown) => ws.reportError(e, what));
  const update = (v: ContentVersionRow, fields: Record<string, unknown>) =>
    void send([{ op: "update", table: "content_versions", id: v.id, fields }], "save the version");

  const add = () =>
    void send(
      addVersionOps({
        contentId,
        versions: store.getState().tables.content_versions,
        persons: store.getState().tables.persons,
        userId: ws.userId,
      }),
      "add a version",
    );

  const remove = (v: ContentVersionRow) => {
    void store
      .mutate([{ op: "delete", table: "content_versions", id: v.id }])
      .then(() =>
        ws.toast(`Version ${v.version ?? ""} deleted.`.replace("  ", " "), "info", {
          duration: UNDO_MS,
          action: {
            label: "Undo",
            run: () => {
              const state = store.getState();
              if (!state.tables.content.has(v.content_id)) return;
              const ops = restoreVersionOps({
                ...v,
                rendered_by:
                  v.rendered_by && state.tables.persons.has(v.rendered_by) ? v.rendered_by : null,
              });
              void send(ops, "restore the version");
            },
          },
        }),
      )
      .catch((e: unknown) => ws.reportError(e, "delete the version"));
  };

  return (
    <div className={vstyles.versions}>
      {canEdit && (
        <button type="button" className={styles.addButton} onClick={add}>
          + Add version
        </button>
      )}
      {versions.length === 0 ? (
        <p className="muted">No versions yet.</p>
      ) : (
        <ul className={styles.cards} aria-label="Versions">
          {versions.map((v) => {
            const status = statusOptions.find((o) => o.value === v.status);
            const who = v.rendered_by ? persons.get(v.rendered_by)?.name : null;
            return (
              <li
                key={v.id}
                className={`${styles.card} ${vstyles.version}`}
                data-testid="version"
                data-current={v.is_current || undefined}
              >
                <div className={vstyles.head}>
                  {canEdit ? (
                    <InlineText
                      label="Version"
                      value={v.version ?? ""}
                      className={vstyles.name}
                      onCommit={(t) => update(v, { version: t || null })}
                    />
                  ) : (
                    <strong className={vstyles.name}>{v.version || "—"}</strong>
                  )}
                  {v.is_current ? (
                    <Chip label="Current" color="green" />
                  ) : canEdit ? (
                    <button
                      type="button"
                      className={vstyles.setCurrent}
                      onClick={() => update(v, { is_current: true })}
                    >
                      Set current
                    </button>
                  ) : null}
                  <span className={vstyles.spacer} />
                  {canEdit && (
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`Delete version ${v.version ?? ""}`.trim()}
                      title="Delete"
                      onClick={() => remove(v)}
                    >
                      ×
                    </button>
                  )}
                </div>
                {canEdit ? (
                  <div className={vstyles.grid}>
                    <label>
                      <span>Status</span>
                      <select
                        value={v.status ?? ""}
                        onChange={(e) => update(v, { status: e.target.value || null })}
                      >
                        <option value="">—</option>
                        {statusOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Date</span>
                      <input
                        type="date"
                        value={v.date ?? ""}
                        onChange={(e) => update(v, { date: e.target.value || null })}
                      />
                    </label>
                    <label>
                      <span>Rendered by</span>
                      <select
                        value={v.rendered_by ?? ""}
                        onChange={(e) => update(v, { rendered_by: e.target.value || null })}
                      >
                        <option value="">—</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || "(no name)"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div>
                      <span aria-hidden="true">File path</span>
                      <InlineText
                        label="File path"
                        value={v.file_path ?? ""}
                        onCommit={(t) => update(v, { file_path: t || null })}
                      />
                    </div>
                    <div className={vstyles.wide}>
                      <span aria-hidden="true">Changes</span>
                      <InlineText
                        label="Changes"
                        multiline
                        value={v.changes ?? ""}
                        onCommit={(t) => update(v, { changes: t || null })}
                      />
                    </div>
                  </div>
                ) : (
                  <div className={styles.cardMeta}>
                    {v.status && <Chip label={v.status} color={optionColor(status?.color)} />}
                    {v.date && <span>{v.date}</span>}
                    {who && <span>{who}</span>}
                    {v.file_path && <span>{v.file_path}</span>}
                    {v.changes && <span className={vstyles.changes}>{v.changes}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A text input whose draft is local while focused; Enter / blur commit, Escape reverts. */
function InlineText({
  value,
  label,
  multiline = false,
  className,
  onCommit,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  className?: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft === null) return;
    const t = draft.trim();
    setDraft(null);
    if (t !== value) onCommit(t);
  };
  const common = {
    "aria-label": label,
    className,
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: finish,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !(multiline && e.shiftKey)) {
        e.preventDefault();
        finish();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDraft(null);
        e.currentTarget.closest<HTMLElement>("[data-testid='row-panel']")?.focus();
      }
    },
  };
  return multiline ? <textarea rows={2} {...common} /> : <input type="text" {...common} />;
}
