// The show workspace (/shows/:id/<tab>): header with presence + theme, the tab bar
// (Cues, Scenes, Content, Notes, People), Show settings, ⌘K, toasts, and the active tab.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import type { MemberDTO, ShowResponse } from "../../../shared/api";
import {
  AirtableImport,
  type AirtableImportHandle,
  IMPORT_LABEL,
} from "../../components/AirtableImport";
import { AppHeader } from "../../components/AppHeader";
import type { SortSpec } from "../../components/grid/types";
import { PresenceIndicator } from "../../components/PresenceIndicator";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useShowSocketState, useShowStoreInstance } from "../../lib/show-store";
import { setTheme } from "../../lib/theme";
import pageStyles from "../../pages/pages.module.css";
import { planSortNow } from "../cues/sortNow";
import { CommandPalette, goToCommands, type PaletteCommand } from "../search/CommandPalette";
import { prefKey, readPref, writePref } from "../shared/prefs";
import { Toasts, useToasts } from "../shared/Toasts";
import type { FocusState } from "../shared/useTableChrome";
import { ShowSettingsButton } from "./ShowSettings";
import styles from "./ShowWorkspace.module.css";
import { rowUrl, TABS, type TabKey } from "./tabs";
import { errorMessage, type Workspace, WorkspaceContext } from "./workspace";

const SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

/** The mutate endpoint takes at most 1000 ops per batch. */
const MAX_BATCH = 1000;

const isSort = (v: unknown): v is SortSpec[] =>
  Array.isArray(v) &&
  v.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as SortSpec).key === "string" &&
      ((s as SortSpec).dir === "asc" || (s as SortSpec).dir === "desc"),
  );

export function ShowWorkspace({ data }: { data: ShowResponse }) {
  const { user } = useAuth();
  const socket = useShowSocketState();
  const store = useShowStoreInstance();
  const navigate = useNavigate();
  const showId = data.show.showId;
  const { items: toasts, toast, dismiss } = useToasts();
  const importer = useRef<AirtableImportHandle>(null);
  const canEdit = data.role === "owner" || data.role === "editor";

  // Members (for note authors, and Show settings).
  const [members, setMembers] = useState<MemberDTO[] | null>(null);
  const loadMembers = useCallback(() => {
    api
      .members(showId)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }, [showId]);
  useEffect(loadMembers, [loadMembers]);
  const memberNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.userId, m.name])),
    [members],
  );

  // Live sort of the cue list (per show, per browser until saved views).
  const sortKey = prefKey.sort(showId, "cues");
  const [cueSort, setCueSortState] = useState<SortSpec[] | undefined>(() =>
    readPref<SortSpec[] | undefined>(
      sortKey,
      undefined,
      isSort as (v: unknown) => v is SortSpec[] | undefined,
    ),
  );
  const setCueSort = useCallback(
    (s: SortSpec[] | undefined) => {
      writePref(sortKey, s);
      setCueSortState(s);
    },
    [sortKey],
  );

  const reportError = useCallback(
    (e: unknown, what: string) => {
      const reason = e instanceof ApiError || e instanceof Error ? errorMessage(e) : String(e);
      toast(`Couldn't ${what}: ${reason}`, "error");
    },
    [toast],
  );

  const sortCuesNow = useCallback(async () => {
    const state = store.getState();
    const cues = state.order.cues.flatMap((id) => state.tables.cues.get(id) ?? []);
    const plan = planSortNow(cues);
    if (plan.ops.length === 0) {
      toast("The cue list is already in cue-number order.");
      setCueSort(undefined);
      return;
    }
    if (plan.unnumbered > 0) {
      const n = plan.unnumbered;
      const ok = window.confirm(
        `${n} ${n === 1 ? "cue has" : "cues have"} no number and will go to the end of the show. Sort anyway?`,
      );
      if (!ok) return;
    }
    try {
      for (let i = 0; i < plan.ops.length; i += MAX_BATCH) {
        await store.mutate(plan.ops.slice(i, i + MAX_BATCH));
      }
      setCueSort(undefined);
      toast("Show order now follows cue numbers.");
    } catch (e) {
      reportError(e, "sort the cue list");
    }
  }, [store, toast, setCueSort, reportError]);

  const workspace = useMemo<Workspace>(
    () => ({
      showId,
      showName: data.show.name,
      role: data.role,
      userId: user?.id ?? "",
      canEdit,
      canComment: canEdit || data.role === "commenter",
      memberNames,
      toast,
      reportError,
      cueSort,
      setCueSort,
      sortCuesNow,
      openImport: () => importer.current?.open(),
    }),
    [
      showId,
      data,
      user,
      canEdit,
      memberNames,
      toast,
      reportError,
      cueSort,
      setCueSort,
      sortCuesNow,
    ],
  );

  // ⌘K / Ctrl+K anywhere in the show.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const go = useCallback(
    (tab: TabKey) => navigate(`/shows/${encodeURIComponent(showId)}/${tab}`),
    [navigate, showId],
  );
  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...(canEdit
        ? [
            {
              id: "sort-now",
              label: "Sort now by cue number",
              run: () => void workspace.sortCuesNow(),
            },
          ]
        : []),
      ...goToCommands(go),
      {
        id: "theme",
        label: "Toggle theme",
        run: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
      },
      ...(canEdit
        ? [{ id: "import", label: IMPORT_LABEL, run: () => workspace.openImport() }]
        : []),
    ],
    [canEdit, go, workspace],
  );
  const onPick = useCallback(
    (tab: TabKey, id: string) => {
      const state: FocusState = { focus: id };
      navigate(rowUrl(showId, tab, id), { state });
    },
    [navigate, showId],
  );

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className={styles.workspace}>
        <AppHeader>
          <h1 className={pageStyles.showTitle} data-testid="show-name" title={data.show.name}>
            {data.show.name}
          </h1>
          <PresenceIndicator {...socket} />
        </AppHeader>
        <nav className={styles.nav} aria-label="Show">
          <div className={styles.tabs}>
            {TABS.map((t) => (
              <NavLink
                key={t.key}
                to={t.key}
                className={({ isActive }) =>
                  isActive ? `${styles.tab} ${styles.activeTab}` : styles.tab
                }
              >
                {t.label}
              </NavLink>
            ))}
          </div>
          <div className={styles.navActions}>
            <button
              type="button"
              className={styles.navButton}
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts="Control+K Meta+K"
              title="Search (⌘K / Ctrl+K)"
            >
              <span aria-hidden="true">⌕</span> <span className={styles.navButtonText}>Search</span>{" "}
              <kbd className={styles.kbd}>{SHORTCUT}</kbd>
            </button>
            <ShowSettingsButton members={members} onMembersChanged={loadMembers} />
          </div>
        </nav>
        {canEdit && (
          <div className={styles.importRow}>
            <AirtableImport showId={showId} ref={importer} />
          </div>
        )}
        <main className={styles.main}>
          <Outlet />
        </main>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={commands}
          onPick={onPick}
        />
        <Toasts items={toasts} dismiss={dismiss} />
      </div>
    </WorkspaceContext.Provider>
  );
}
