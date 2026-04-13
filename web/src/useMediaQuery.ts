import { useSyncExternalStore } from "react";

/** Subscribes to `window.matchMedia` without synchronous setState in an effect. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onStoreChange);
      return () => m.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
