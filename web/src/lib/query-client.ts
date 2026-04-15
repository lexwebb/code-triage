import { QueryClient } from "@tanstack/react-query";

let queryClientSingleton: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!queryClientSingleton) {
    queryClientSingleton = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          gcTime: 5 * 60_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    });
  }
  return queryClientSingleton;
}

/** Vitest / isolated runs */
export function resetQueryClientForTests(): void {
  queryClientSingleton = null;
}
