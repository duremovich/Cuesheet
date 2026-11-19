// The details line under a member: who added them, when they joined, when they were last
// active ("3 days ago").
import type { ReactNode } from "react";
import type { PersonRefDTO } from "../../../shared/api";
import { relativeTime, shortDate } from "../../lib/relativeTime";
import styles from "./Teams.module.css";

export function MemberMeta({
  invitedBy,
  joinedAt,
  lastActiveAt,
  children,
}: {
  invitedBy: PersonRefDTO | null;
  joinedAt: number;
  lastActiveAt: number | null;
  /** Shown first (e.g. "via <team>"). */
  children?: ReactNode;
}) {
  const parts = [
    invitedBy ? `Invited by ${invitedBy.name}` : null,
    `joined ${shortDate(joinedAt)}`,
    lastActiveAt ? `active ${relativeTime(lastActiveAt)}` : "not active yet",
  ].filter(Boolean);
  const text = parts.join(" · ");
  return (
    <span className={styles.meta} data-testid="member-meta">
      {children}
      {children ? " · " : ""}
      {children ? text : text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}
