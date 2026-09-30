import type { ShowSocketState } from "../lib/useShowSocket";
import styles from "./PresenceIndicator.module.css";

const LABEL = { connecting: "Connecting…", connected: "Live", disconnected: "Offline" } as const;

export function PresenceIndicator({ status, clients }: ShowSocketState) {
  return (
    <div
      className={styles.presence}
      data-testid="presence"
      data-status={status}
      data-clients={clients}
      role="status"
      aria-live="polite"
    >
      <span className={`${styles.dot} ${styles[status]}`} aria-hidden="true" />
      <span>{LABEL[status]}</span>
      {status === "connected" && (
        <span className={styles.count} data-testid="presence-count">
          {clients} {clients === 1 ? "client" : "clients"}
        </span>
      )}
    </div>
  );
}
