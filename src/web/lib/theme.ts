// Theme selection. Dark unless the user has explicitly chosen light; the system color
// scheme is deliberately ignored. The pre-paint copy of this logic is in index.html.
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
export const THEME_STORAGE_KEY = "cuesheet.theme";

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

/** The user's stored choice, otherwise dark. */
export function resolveTheme(stored: string | null): Theme {
  return isTheme(stored) ? stored : "dark";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Current theme plus a setter that persists the user's choice. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readStored()));

  useEffect(() => applyTheme(theme), [theme]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    setThemeState(t);
  }, []);

  return [theme, setTheme];
}
