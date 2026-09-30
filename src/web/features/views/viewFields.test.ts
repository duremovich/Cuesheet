// The server validates view configs against VIEW_FIELDS (src/shared/views.ts); it must name
// exactly the columns each tab shows, with the kind the client filters them as.
import { describe, expect, it } from "vitest";
import type { DataTableName } from "../../../shared/tables";
import { VIEW_FIELDS } from "../../../shared/views";
import type { Column } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { contentColumns } from "../content/columns";
import { cueColumns } from "../cues/columns";
import { noteColumns } from "../notes/columns";
import { personColumns } from "../people/columns";
import { sceneColumns } from "../scenes/columns";
import { fieldKind } from "./evaluate";
import { DATE_FIELDS } from "./tableDefaults";

const store = {} as ShowStore;
const columns: Record<DataTableName, Column<never>[]> = {
  cues: cueColumns({ store, fieldOptions: {}, editable: true }) as Column<never>[],
  notes: noteColumns({ store, fieldOptions: {}, canCreateRecords: true }) as Column<never>[],
  content: contentColumns({ store, fieldOptions: {}, editable: true }) as Column<never>[],
  scenes: sceneColumns({}, true) as Column<never>[],
  persons: personColumns({}, true) as Column<never>[],
};

describe("VIEW_FIELDS matches the tabs' columns", () => {
  for (const table of Object.keys(columns) as DataTableName[]) {
    it(table, () => {
      const fromColumns = Object.fromEntries(
        columns[table].map((c) => [
          c.key,
          fieldKind({
            type: c.type,
            ...(DATE_FIELDS[table]?.includes(c.key) ? { valueType: "date" as const } : {}),
          }),
        ]),
      );
      const declared = Object.fromEntries(
        Object.entries(VIEW_FIELDS[table])
          .filter(([, f]) => !f.extra)
          .map(([k, f]) => [k, f.kind]),
      );
      expect(declared).toEqual(fromColumns);
    });
  }
});
