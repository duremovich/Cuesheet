// /shows/:id/print/<tab>?view=<id>: the tab's own component in print mode. The tab builds
// its rows and saved view exactly as on screen (useViewConfig: `?view=`, else the last
// view you opened, else the shared default) and renders `PrintTable` instead of the grid.
import type { ComponentType } from "react";
import { Link, useParams } from "react-router";
import { TABS, type TabKey } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import { PrintModeContext, useLightTheme } from "./PrintShell";

export function TablePrintRoute({ grids }: { grids: Record<TabKey, ComponentType> }) {
  const { table = "" } = useParams();
  const ws = useWorkspace();
  const tab = TABS.find((t) => t.key === table);
  useLightTheme();
  if (!tab) {
    return (
      <main style={{ padding: 24 }}>
        <p>There's no table "{table}" to print.</p>
        <Link to={`/shows/${encodeURIComponent(ws.showId)}/cues`}>Back to the show</Link>
      </main>
    );
  }
  const Grid = grids[tab.key];
  return (
    <PrintModeContext.Provider value={true}>
      <Grid />
    </PrintModeContext.Provider>
  );
}
