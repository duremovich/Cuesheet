// Set by the share page (/s/<token>, R23): the layouts it renders (the print components)
// adapt: no Back link or app navigation, and a `view` link keeps the viewer's theme and
// lets rows open read-only.
import { createContext, useContext } from "react";
import type { ShareKind, ShareOptions } from "../../../shared/share";

export interface ShareMode {
  token: string;
  kind: ShareKind;
  label: string | null;
  /** What the link fixes (notes presets: session / person, enforced by the server). */
  options: ShareOptions;
}

export const ShareContext = createContext<ShareMode | null>(null);

export function useShareMode(): ShareMode | null {
  return useContext(ShareContext);
}
