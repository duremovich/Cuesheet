// Theme selection. Dark is the default; light is opt-in (or follows a system "light"
// preference until the user picks). The pre-paint copy of this logic is in index.html.
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
export const THEME_STORAGE_KEY = "cuesheet.theme";

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

/** Stored choice wins; otherwise follow the system only if it explicitly prefers light. */
export function resolveTheme(stored: string | null, systemPrefersLight: boolean): Theme {
  if (isTheme(stored)) return stored;
  return systemPrefersLight ? "light" : "dark";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Current theme plus a setter that persists the user's choice. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveTheme(readStored(), lightQuery().matches),
  );

  useEffect(() => applyTheme(theme), [theme]);

  // Until the user chooses, track system changes.
  useEffect(() => {
    const mq = lightQuery();
    const onChange = () => {
      if (!isTheme(readStored())) setThemeState(resolveTheme(null, mq.matches));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
