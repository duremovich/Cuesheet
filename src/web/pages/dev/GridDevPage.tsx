// /dev/grid: the DataGrid against an in-memory copy of the Some Like It Hot cue list.
// Dev and preview builds only (see ./routes.tsx); no login, no server data.

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  type ColorRule,
  type Column,
  DataGrid,
  type RowHeight,
  type SortSpec,
} from "../../components/grid";
import { ThemeToggle } from "../../components/ThemeToggle";
import styles from "./GridDevPage.module.css";
import {
  cueNumberHints,
  type MockCue,
  MockShowStore,
  STATUS_OPTIONS,
  seedFromExamples,
  stressSeed,
} from "./mockShow";

const STRESS_ROWS = 5000;

function makeColumns(store: MockShowStore): Column<MockCue>[] {
  return [
    {
      key: "number",
      title: "Cue",
      type: "text",
      width: 80,
      frozen: true,
      getValue: (r) => r.number,
    },
    { key: "page", title: "Pg", type: "text", width: 56, getValue: (r) => r.page },
    { key: "smCall", title: "SM Call", type: "longtext", width: 220, getValue: (r) => r.smCall },
    { key: "lx", title: "LX", type: "text", width: 64, getValue: (r) => r.lx },
    { key: "timecode", title: "Timecode", type: "text", width: 110, getValue: (r) => r.timecode },
    { key: "msr", title: "MSR", type: "number", width: 70, getValue: (r) => r.msr },
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 240,
      getValue: (r) => r.description,
    },
    {
      key: "status",
      title: "Status",
      type: "select",
      width: 130,
      options: STATUS_OPTIONS,
      getValue: (r) => r.status,
    },
    {
      key: "assignees",
      title: "Assignee",
      type: "multilink",
      width: 180,
      search: store.searchPeople,
      getValue: (r) => r.assignees,
    },
    {
      key: "content",
      title: "Content",
      type: "multilink",
      width: 240,
      search: (q, row) => store.searchContent(q, row.sceneId),
      create: (name, row) => store.createContent(name, row.sceneId),
      getValue: (r) => r.content,
    },
    {
      key: "programmed",
      title: "Programmed",
      type: "checkbox",
      width: 100,
      getValue: (r) => r.programmed,
    },
    {
      key: "scene",
      title: "Scene",
      type: "readonly",
      width: 200,
      getValue: (r) => store.sceneTitle(r.sceneId),
    },
    {
      key: "notes",
      title: "Content Notes",
      type: "longtext",
      width: 260,
      getValue: (r) => r.notes,
    },
  ];
}

const COLOR_PRESETS: Record<string, ColorRule<MockCue>[]> = {
  none: [],
  status: STATUS_OPTIONS.map((o) => ({ when: (r: MockCue) => r.status === o.value, row: o.color })),
  noContent: [
    {
      when: (r: MockCue) => !r.isSection && r.content.length === 0,
      cell: { key: "content", color: "orange" },
    },
  ],
};

function useStore(store: MockShowStore) {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export function GridDevPage() {
  const seed = useMemo(() => seedFromExamples(), []);
  const [stress, setStress] = useState(false);
  const store = useMemo(
    () => new MockShowStore(stress ? stressSeed(seed, STRESS_ROWS) : seed),
    [seed, stress],
  );
  const version = useStore(store);
  const [grouped, setGrouped] = useState(true);
  const [sorted, setSorted] = useState(false);
  const [rowHeight, setRowHeight] = useState<RowHeight>("normal");
  const [preset, setPreset] = useState("none");
  const [log, setLog] = useState("Ready");

  const columns = useMemo(() => makeColumns(store), [store]);
  // Duplicate-number warnings and ghost midpoint numbers on the Cue column (R3).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the store's change signal
  const cellDecoration = useMemo(() => {
    const hints = cueNumberHints(store.list());
    return (row: MockCue, key: string) => (key === "number" ? hints.get(row.id) : undefined);
  }, [store, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the store's change signal
  const data = useMemo(
    () => (grouped ? { groups: store.groups() } : { rows: store.list() }),
    [store, grouped, version],
  );
  const sort = useMemo<SortSpec[] | undefined>(
    () => (sorted ? [{ key: "number", dir: "asc" }] : undefined),
    [sorted],
  );
  const label = (id: string) => {
    const c = store.get(id);
    return c ? c.number || c.description || "(unnumbered)" : id;
  };

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <h1 className={styles.title}>DataGrid</h1>
        <label className={styles.check}>
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group by scene
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={sorted} onChange={(e) => setSorted(e.target.checked)} />
          Live sort by cue number
        </label>
        <label className={styles.inline}>
          Row height
          <select value={rowHeight} onChange={(e) => setRowHeight(e.target.value as RowHeight)}>
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="tall">Tall</option>
          </select>
        </label>
        <label className={styles.inline}>
          Colors
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="none">None</option>
            <option value="status">By status</option>
            <option value="noContent">Cues with no content</option>
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={stress} onChange={(e) => setStress(e.target.checked)} />
          {STRESS_ROWS.toLocaleString("en-US")} rows
        </label>
        <ThemeToggle />
        <output className={styles.log} data-testid="grid-log">
          {log}
        </output>
      </header>
      <div className={styles.gridWrap}>
        <DataGrid<MockCue>
          aria-label="Cue list"
          columns={columns}
          rowId={(r) => r.id}
          {...data}
          isSection={(r) => r.isSection}
          sectionLabelKey="description"
          sort={sort}
          rowHeight={rowHeight}
          colorRules={COLOR_PRESETS[preset]}
          cellDecoration={cellDecoration}
          onEdit={(id, key, value) => {
            store.edit(id, key, value);
            setLog(`Edited ${label(id)} · ${key}`);
          }}
          onInsert={(pos) => {
            const id = store.insert(pos);
            setLog("Inserted a row");
            return id;
          }}
          onMove={(id, pos) => {
            store.move(id, pos);
            setLog(`Moved ${label(id)}`);
          }}
          onDelete={(ids) => {
            store.remove(ids);
            setLog(`Deleted ${ids.length} row${ids.length === 1 ? "" : "s"}`);
          }}
          onOpenRow={(id) => setLog(`Open ${label(id)}`)}
        />
      </div>
    </div>
  );
}
