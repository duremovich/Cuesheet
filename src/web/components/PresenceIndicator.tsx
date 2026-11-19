import { useEffect, useRef, useState } from "react";
import type { PresenceUser } from "../../shared/ws";
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

/** How a presence entry reads: a share link's visitors as guests, a member by name. */
function entryName(u: PresenceUser): string {
  if (u.id.startsWith("share:") && u.connections > 1) return `${u.connections} guests (read-only)`;
  return u.name;
}

/** A member with several tabs or devices open: "3 tabs" (share visitors are guests). */
function tabsNote(u: PresenceUser): string | null {
  return !u.id.startsWith("share:") && u.connections > 1 ? `${u.connections} tabs` : null;
}

/**
 * Connection status and who's here (R22): how many people are online (an account once,
 * however many tabs; each share visitor a guest; "online", not "people", which is the
 * show's contact-sheet tab), and how many of them are read-only (viewers and share links,
 * with an eye). Hovering the count names who's here; clicking it lists them, a line a
 * person, with a quiet "· 3 tabs" for someone connected more than once (share visitors as
 * guests). `self`: you are read-only here (viewer, share page), shown as "Read-only";
 * `bare`: just the status (share pages show no counts or names).
 */
export function PresenceIndicator({
  status,
  people,
  clients,
  readOnly = 0,
  users = [],
  self,
  bare,
}: ShowSocketState & { self?: boolean; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const names = users
    .map((u) => {
      const name =
        u.readOnly && !u.id.startsWith("share:") ? `${u.name} (read-only)` : entryName(u);
      const tabs = tabsNote(u);
      return tabs ? `${name} (${tabs})` : name;
    })
    .join(", ");
  const countText = `${people} online`;
  return (
    <div
      ref={wrap}
      className={styles.presence}
      data-testid="presence"
      data-status={status}
      data-people={people}
      data-clients={clients}
      data-read-only={readOnly}
    >
      <span className={`${styles.dot} ${styles[status]}`} aria-hidden="true" />
      <span>{LABEL[status]}</span>
      {status === "connected" && !bare && users.length === 0 && (
        <span className={styles.count} data-testid="presence-count" aria-live="polite">
          {countText}
        </span>
      )}
      {status === "connected" && !bare && users.length > 0 && (
        <button
          type="button"
          ref={button}
          className={styles.countButton}
          title={names}
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={`${countText}: who's here`}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            // Focus stays on the button while the list is open: Escape closes it here.
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <span className={styles.count} data-testid="presence-count" aria-live="polite">
            {countText}
          </span>
        </button>
      )}
      {open && status === "connected" && (
        <ul
          className={styles.list}
          data-testid="presence-list"
          aria-label="Who's here"
          // biome-ignore lint/a11y/noRedundantRoles: list-style none drops the implicit role in Safari
          role="list"
        >
          {users.map((u) => {
            const tabs = tabsNote(u);
            return (
              <li key={u.id} data-read-only={u.readOnly || undefined}>
                {u.readOnly && <EyeIcon />}
                {entryName(u)}
                {u.readOnly && !u.id.startsWith("share:") ? (
                  <span className={styles.count}> read-only</span>
                ) : null}
                {tabs ? (
                  <span className={styles.count} data-testid="presence-tabs">
                    {` · ${tabs}`}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
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
