import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

/** When `when` is true, renders `fallback` instead of `children`. */
export function LoadingBoundary({
  when,
  fallback,
  children,
}: {
  when: boolean;
  fallback: ReactNode;
  children: ReactNode;
}): ReactNode {
  if (when) return fallback;
  return children;
}

const PrDetailLoadingContext = createContext<boolean | null>(null);

/** Supplies `prDetailLoading` for the reviews subtree (one Zustand subscription at the provider). */
export function PrDetailLoadingProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <PrDetailLoadingContext.Provider value={value}>
      {children}
    </PrDetailLoadingContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePrDetailLoading(): boolean {
  const v = useContext(PrDetailLoadingContext);
  if (v === null) {
    throw new Error("usePrDetailLoading must be used under PrDetailLoadingProvider");
  }
  return v;
}
