// What every tab of the show workspace needs besides the store: who you are here, what you
// may do, and the workspace-level actions (toasts, import, ⌘K commands).
import { createContext, useContext } from "react";
import type { Role } from "../../../shared/api";
import type { ToastAction, ToastKind } from "../shared/Toasts";

export interface Workspace {
  showId: string;
  showName: string;
  role: Role;
  userId: string;
  /** owner / editor: everything. */
  canEdit: boolean;
  /** Commenters and up may create notes (and edit their own). */
  canComment: boolean;
  /** Member user id → display name (for created_by on notes). */
  memberNames: ReadonlyMap<string, string>;
  toast(message: string, kind?: ToastKind, action?: ToastAction): void;
  /** Toast a failed action ("Couldn't move the cue: …"). */
  reportError(error: unknown, what: string): void;
  /**
   * "Sort now by cue number" (asks first when unnumbered cues would go last). Resolves true
   * when show order now follows cue numbers (the cue view then drops its live sort).
   */
  sortCuesNow(): Promise<boolean>;
  /** Opens the Airtable import file chooser (editors). */
  openImport(): void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace must be used inside the show workspace");
  return ws;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
