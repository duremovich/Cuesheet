import type { ShowSocketState } from "../lib/useShowSocket";
import styles from "./PresenceIndicator.module.css";

const LABEL = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Offline",
  unauthorized: "No access",
} as const satisfies Record<ShowSocketState["status"], string>;

/** An eye: read-only (viewers, share links). */
export function EyeIcon() {
  return (
    <svg
      className={styles.eye}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 3C4.4 3 1.7 5.6 1 8c.7 2.4 3.4 5 7 5s6.3-2.6 7-5c-.7-2.4-3.4-5-7-5Zm0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4Zm0-1.7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Connection status and who's here: client count, and how many of them are read-only
 * (viewers and share links, with an eye). `self`: you are read-only here (viewer, share
 * page), shown as "Read-only"; `bare`: just the status (share pages show no counts).
 */
export function PresenceIndicator({
  status,
  clients,
  readOnly = 0,
  self,
  bare,
}: ShowSocketState & { self?: boolean; bare?: boolean }) {
  return (
    <div
      className={styles.presence}
      data-testid="presence"
      data-status={status}
      data-clients={clients}
      data-read-only={readOnly}
      role="status"
      aria-live="polite"
    >
      <span className={`${styles.dot} ${styles[status]}`} aria-hidden="true" />
      <span>{LABEL[status]}</span>
      {status === "connected" && !bare && (
        <span className={styles.count} data-testid="presence-count">
          {clients} {clients === 1 ? "client" : "clients"}
        </span>
      )}
      {status === "connected" && !bare && readOnly > 0 && (
        <span
          className={styles.count}
          data-testid="presence-read-only"
          title={`${readOnly} read-only (viewers and share links)`}
        >
          <EyeIcon /> {readOnly}
        </span>
      )}
      {self && (
        <span className={styles.self} data-testid="presence-self-read-only">
          <EyeIcon /> Read-only
        </span>
      )}
    </div>
  );
}
