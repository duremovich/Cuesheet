// "Show settings" popover: units, Airtable import (editors), storage, members (everyone
// sees them; the owner manages them: ShareSettingsMembers.tsx) and sharing (owner:
// ShareSettings.tsx).
import { useEffect, useRef, useState } from "react";
import type { MemberDTO, StorageResponse } from "../../../shared/api";
import { formatBytes } from "../../../shared/attachments";
import { isUnit, UNIT_LABELS, UNITS } from "../../../shared/units";
import { IMPORT_LABEL } from "../../components/AirtableImport";
import { api } from "../../lib/api";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { setUserUnit, useUserUnit } from "../views/units";
import { SharingSection } from "./ShareSettings";
import { MembersSection } from "./ShareSettingsMembers";
import styles from "./ShowWorkspace.module.css";
import { useWorkspace } from "./workspace";

export function ShowSettingsButton({
  members,
  onMembersChanged,
}: {
  members: MemberDTO[] | null;
  onMembersChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    panel.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className={styles.settingsWrap}>
      <button
        type="button"
        ref={button}
        className={styles.navButton}
        aria-haspopup="dialog"
        aria-label="Show settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⚙</span>{" "}
        <span className={styles.navButtonText}>Show settings</span>
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Show settings"
          className={styles.settings}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <SettingsBody
            members={members}
            onMembersChanged={onMembersChanged}
            close={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function SettingsBody({
  members,
  onMembersChanged,
  close,
}: {
  members: MemberDTO[] | null;
  onMembersChanged: () => void;
  close: () => void;
}) {
  const ws = useWorkspace();
  return (
    <div className={styles.settingsBody}>
      <UnitSettings />
      {ws.canEdit && (
        <section>
          <h3>Data</h3>
          <button
            type="button"
            onClick={() => {
              close();
              ws.openImport();
            }}
          >
            {IMPORT_LABEL}
          </button>
        </section>
      )}
      <StorageUsage />
      {/* Members and Sharing: ShareSettingsMembers.tsx / ShareSettings.tsx (M5b). */}
      <MembersSection members={members} onMembersChanged={onMembersChanged} />
      {ws.canEdit && <SharingSection />}
    </div>
  );
}

/** Attachment storage used by the show, of its 2 GB (R13). */
function StorageUsage() {
  const ws = useWorkspace();
  const [usage, setUsage] = useState<StorageResponse | null>(null);
  useEffect(() => {
    let live = true;
    api
      .storage(ws.showId)
      .then((u) => {
        if (live) setUsage(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws.showId]);
  return (
    <section>
      <h3>Storage</h3>
      {usage ? (
        <p data-testid="storage-usage">
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.limitBytes)} used for attachments
          <meter
            className={styles.storageMeter}
            min={0}
            max={usage.limitBytes}
            value={usage.usedBytes}
            aria-label="Attachment storage used"
          />
        </p>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </section>
  );
}

/**
 * Measurement units (R11): the show's default (editors; stored in the ShowDO via the
 * `meta` op) and your own preference in this browser, which wins over it. A view's unit
 * override (Fields → Unit override) wins over both.
 */
function UnitSettings() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const showUnit = useShowStore((s) => s.meta.default_unit);
  const myUnit = useUserUnit(ws.userId);
  return (
    <section>
      <h3>Units</h3>
      <div className={styles.unitRow}>
        <label htmlFor="show-default-unit">Show default</label>
        <select
          id="show-default-unit"
          value={showUnit ?? "m"}
          disabled={!ws.canEdit}
          onChange={(e) => {
            const v = e.target.value;
            if (!isUnit(v)) return;
            store
              .mutate([{ op: "meta", fields: { default_unit: v } }])
              .catch((err: unknown) => ws.reportError(err, "change the default unit"));
          }}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.unitRow}>
        <label htmlFor="my-unit">My unit</label>
        <select
          id="my-unit"
          value={myUnit ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setUserUnit(ws.userId, isUnit(v) ? v : null);
          }}
        >
          <option value="">Show default</option>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
