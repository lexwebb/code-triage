import { QueryClient } from "@tanstack/react-query";

const GLOBAL_QUERY_CLIENT_KEY = "__CR_WATCH_QUERY_CLIENT__";
const globalQueryClientHost = globalThis as typeof globalThis & {
  [GLOBAL_QUERY_CLIENT_KEY]?: QueryClient;
};

export function getQueryClient(): QueryClient {
  if (!globalQueryClientHost[GLOBAL_QUERY_CLIENT_KEY]) {
    globalQueryClientHost[GLOBAL_QUERY_CLIENT_KEY] = new QueryClient({
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
  return globalQueryClientHost[GLOBAL_QUERY_CLIENT_KEY]!;
}

/** Vitest / isolated runs */
export function resetQueryClientForTests(): void {
  delete globalQueryClientHost[GLOBAL_QUERY_CLIENT_KEY];
}
