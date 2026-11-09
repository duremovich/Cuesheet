// Delete rows from a grid with an Undo toast (every table tab): send the delete, keep what
// the server says it did (the cascade), and offer Undo for a while, which rebuilds it all
// from the state before the delete (`deleteRestoreOps`).
import type { Op } from "../../../shared/ops";
import type { TableName } from "../../../shared/tables";
import type { ShowStore } from "../../lib/show-store";
import type { useWorkspace } from "../show/workspace";
import { mutateInBatches } from "./ops";
import { deleteRestoreOps } from "./restore";

/** How long a delete's Undo stays in the toast (as for a note card's ×). */
export const DELETE_UNDO_MS = 8000;

type Workspace = Pick<ReturnType<typeof useWorkspace>, "toast" | "reportError">;

/** Resolves true once the delete landed (false: it failed and was reported). */
export function deleteWithUndo(
  store: ShowStore,
  ws: Workspace,
  ops: Op[],
  count: number,
  noun: { one: string; other: string },
): Promise<boolean> {
  if (ops.length === 0) return Promise.resolve(false);
  const before = store.getState();
  const name = count === 1 ? noun.one : noun.other;
  const what = count === 1 ? `the ${noun.one}` : `the ${noun.other}`;
  return mutateInBatches((b) => store.mutateResolved(b), ops).then(
    (resolved) => {
      ws.toast(`Deleted ${count} ${name}.`, "info", {
        duration: DELETE_UNDO_MS,
        action: {
          label: "Undo",
          run: () => {
            const now = store.getState();
            const exists = (t: TableName, id: string) =>
              (now.tables[t] as Map<string, unknown>).has(id);
            const undo = deleteRestoreOps(before, resolved, exists);
            void mutateInBatches((b) => store.mutate(b), undo).catch((e: unknown) =>
              ws.reportError(e, `restore ${what}`),
            );
          },
        },
      });
      return true;
    },
    (e: unknown) => {
      ws.reportError(e, `delete ${what}`);
      return false;
    },
  );
}
