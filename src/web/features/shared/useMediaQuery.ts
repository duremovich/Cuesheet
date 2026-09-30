// Whether a CSS media query matches, live (false where matchMedia doesn't exist).
import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" ? !!window.matchMedia?.(query).matches : false),
    () => false,
  );
}
