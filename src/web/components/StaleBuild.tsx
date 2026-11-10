// The UI of stale-build recovery (src/web/lib/staleBuild.ts): the banner that says what's
// happening (reloading / saving your edits first / please reload), and the router's error
// element, which hands chunk-load failures to the recovery and shows anything else plainly
// instead of React Router's raw "Unexpected Application Error".
import { useEffect, useSyncExternalStore } from "react";
import { Link, useRouteError } from "react-router";
import { isChunkLoadError, staleBuild } from "../lib/staleBuild";
import styles from "./StaleBuild.module.css";

const MESSAGES = {
  reloading: "Cuesheet was updated. Reloading…",
  waiting: "Cuesheet was updated. Reloading once your edits are saved…",
  prompt: "Cuesheet was updated. Reload the page to get the new version.",
} as const;

/** Fixed banner while a stale-build recovery is under way or needs the user. */
export function StaleBuildBanner() {
  const state = useSyncExternalStore(staleBuild.subscribe, staleBuild.getState);
  if (state === "ok") return null;
  return (
    <div className={styles.banner} role="alert" data-testid="stale-build" data-state={state}>
      <span>{MESSAGES[state]}</span>
      {state !== "reloading" && (
        <button type="button" className="primary" onClick={() => staleBuild.reloadByUser()}>
          {state === "waiting" ? "Reload now" : "Reload"}
        </button>
      )}
    </div>
  );
}

/** `errorElement` for the routes (main.tsx). */
export function RouteError() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  useEffect(() => {
    if (stale) staleBuild.recover();
  }, [stale]);
  if (stale) {
    // The banner carries the message and the button.
    return <main className={styles.page} data-testid="route-error" data-kind="stale" />;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main className={styles.page} data-testid="route-error" data-kind="error">
      <h1 className={styles.title}>Something went wrong</h1>
      <p className={styles.detail}>{message}</p>
      <p className={styles.actions}>
        <button type="button" className="primary" onClick={() => staleBuild.reloadByUser()}>
          Reload
        </button>
        <Link to="/">Back to shows</Link>
      </p>
    </main>
  );
}
