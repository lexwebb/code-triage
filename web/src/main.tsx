import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./tanstack-router";
import { getQueryClient } from "./lib/query-client";
import { trpc, trpcClient } from "./lib/trpc";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={getQueryClient()}>
      <QueryClientProvider client={getQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
