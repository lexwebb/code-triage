import { createTRPCReact } from "@trpc/react-query";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../src/trpc/router";

export const trpc = createTRPCReact<AppRouter>();

const wsClient = createWSClient({
  url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/trpc`,
});

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: wsLink<AppRouter>({
        client: wsClient,
        transformer: superjson,
      }),
      false: httpBatchLink({
        transformer: superjson,
        url: "/trpc",
      }),
    }),
  ],
});
