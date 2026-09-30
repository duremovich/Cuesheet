// /s/<token>: a read-only share link (R23), no sign-in. Resolves the link
// (`GET /api/share/:token`, which also gives this browser a cookie for the show's data
// routes), then renders just its target on the live show store: a table's saved view (the
// print table on screen, with a read-only row expand; the viewer's theme), or a print
// layout (SM cue sheet, calling script, notes by person / by cue, content list, surface
// sheet; light). No tabs, panels, members or presence names: "Live" only. When the link
// is revoked the socket is closed and the page shows why (410).
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import type { ShareInfoResponse } from "../../../shared/share";
import { ApiError, api } from "../../lib/api";
import {
  ShowStoreProvider,
  useShowSocketState,
  useShowStore,
  useShowStoreInstance,
} from "../../lib/show-store";
import pageStyles from "../../pages/pages.module.css";
import { CallingScriptPrint } from "../print/CallingScriptPrint";
import { PrintModeContext } from "../print/PrintShell";
import { isTabPreset, PresetPrint } from "../print/presets";
import { ScriptSourceProvider } from "../script/source";
import { Toasts, useToasts } from "../shared/Toasts";
import { TABS, type TabKey } from "../show/tabs";
import { errorMessage, type Workspace, WorkspaceContext } from "../show/workspace";
import { ShareContext, type ShareMode } from "./context";

type Grids = Record<TabKey, ComponentType>;

type Load =
  | { status: "loading" }
  | { status: "ok"; info: ShareInfoResponse }
  | { status: "gone"; code: number; message: string };

/** Search engines: never index a share page (the Worker also sends X-Robots-Tag). */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export function SharePage({ grids }: { grids: Grids }) {
  const { token = "" } = useParams();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useNoIndex();

  const resolve = useCallback(() => {
    api
      .openShare(token)
      .then((info) => setLoad({ status: "ok", info }))
      .catch((e: unknown) =>
        setLoad({
          status: "gone",
          code: e instanceof ApiError ? e.status : 0,
          message: errorMessage(e),
        }),
      );
  }, [token]);
  useEffect(resolve, [resolve]);

  if (load.status === "loading") {
    return (
      <p className="muted" style={{ padding: 24 }}>
        Loading…
      </p>
    );
  }
  if (load.status === "gone") return <Gone code={load.code} message={load.message} />;
  return <SharedShow info={load.info} token={token} grids={grids} onRevoked={resolve} />;
}

function Gone({ code, message }: { code: number; message: string }) {
  const text =
    code === 410
      ? "This link has been revoked or has expired. Ask whoever shared it for a new one."
      : code === 429
        ? message
        : code === 404
          ? "This link doesn't exist. Check that you copied all of it."
          : `The link couldn't be opened: ${message}`;
  return (
    <main className={pageStyles.centered} data-testid="share-gone" data-status={code}>
      <div className={pageStyles.authCard}>
        <h1>{code === 410 ? "Link no longer available" : "Can't open this link"}</h1>
        <p>{text}</p>
      </div>
    </main>
  );
}

/** The URL parameters the target layout reads (`?view=`, `?layout=`, `?preset=`…). */
function targetParams(info: ShareInfoResponse): Record<string, string> {
  const { link } = info;
  const out: Record<string, string> = {};
  if (link.viewId) out.view = link.viewId;
  if (link.preset === "cuesheet") out.layout = "cuesheet";
  else if (link.preset && link.preset !== "calling-script") out.preset = link.preset;
  if (link.options.session) out.session = link.options.session;
  if (link.options.orient) out.orient = link.options.orient;
  return out;
}

function SharedShow({
  info,
  token,
  grids,
  onRevoked,
}: {
  info: ShareInfoResponse;
  token: string;
  grids: Grids;
  onRevoked: () => void;
}) {
  const location = useLocation();
  // Put the target's parameters in the URL first (the layouts read them from there); the
  // viewer's own extras (e.g. ?person= from a "Distribute notes" email) stay.
  const params = new URLSearchParams(location.search);
  const wanted = targetParams(info);
  const missing = Object.entries(wanted).filter(([k]) => !params.has(k));
  if (missing.length > 0) {
    for (const [k, v] of missing) params.set(k, v);
    return <Navigate to={{ pathname: location.pathname, search: `?${params}` }} replace />;
  }
  return (
    <ShowStoreProvider
      showId={info.show.id}
      show={{ name: info.show.name, currentSession: info.show.currentSession }}
    >
      <ShareWorkspace info={info} token={token} grids={grids} onRevoked={onRevoked} />
    </ShowStoreProvider>
  );
}

function ShareWorkspace({
  info,
  token,
  grids,
  onRevoked,
}: {
  info: ShareInfoResponse;
  token: string;
  grids: Grids;
  onRevoked: () => void;
}) {
  const store = useShowStoreInstance();
  const socket = useShowSocketState();
  const storeStatus = useShowStore((s) => s.status);
  const showName = useShowStore((s) => s.show?.name) ?? info.show.name;
  const { items: toasts, toast, dismiss } = useToasts();
  const showId = info.show.id;

  // The socket was closed for good (the link was revoked): ask the server what happened.
  useEffect(() => {
    if (socket.status === "unauthorized") onRevoked();
  }, [socket.status, onRevoked]);

  const workspace = useMemo<Workspace>(
    () => ({
      showId,
      showName,
      role: "viewer",
      userId: "",
      canEdit: false,
      canComment: false,
      memberNames: new Map(),
      toast,
      reportError: (e: unknown, what: string) => toast(`Couldn't ${what}: ${errorMessage(e)}`),
      sortCuesNow: async () => false,
      openImport: () => undefined,
    }),
    [showId, showName, toast],
  );
  const mode = useMemo<ShareMode>(
    () => ({ token, kind: info.link.kind, label: info.link.label }),
    [token, info.link.kind, info.link.label],
  );

  return (
    <WorkspaceContext.Provider value={workspace}>
      <ShareContext.Provider value={mode}>
        <ScriptSourceProvider store={store} showId={showId}>
          <div data-testid="share-page" data-store-status={storeStatus} data-kind={mode.kind}>
            <Target info={info} grids={grids} />
          </div>
          <Toasts items={toasts} dismiss={dismiss} />
        </ScriptSourceProvider>
      </ShareContext.Provider>
    </WorkspaceContext.Provider>
  );
}

function Target({ info, grids }: { info: ShareInfoResponse; grids: Grids }) {
  const { link } = info;
  if (link.preset === "calling-script") return <CallingScriptPrint />;
  const tab = TABS.find((t) => t.table === link.table);
  if (link.preset && link.preset !== "cuesheet") {
    return tab && isTabPreset(tab.key, link.preset) ? <PresetPrint preset={link.preset} /> : null;
  }
  if (!tab) return <p style={{ padding: 24 }}>This link shows a table that no longer exists.</p>;
  const Grid = grids[tab.key];
  return (
    <PrintModeContext.Provider value={true}>
      <Grid />
    </PrintModeContext.Provider>
  );
}
