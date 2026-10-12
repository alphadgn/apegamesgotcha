import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Data stays fresh for 20s, so going back to a page shows it straight away instead of reloading it
        // (live data such as spins and the draw status refresh on their own timers).
        staleTime: 20_000,
        refetchOnWindowFocus: false,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Start loading a page as soon as a link is touched or hovered, so it's ready when the tap lands.
    defaultPreload: "intent",
    // Only show the loading indicator for loads longer than 200 ms, and then for at least 300 ms (no flicker).
    defaultPendingMs: 200,
    defaultPendingMinMs: 300,
  });

  return router;
};
