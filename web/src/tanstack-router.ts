import { createRouter } from "@tanstack/react-router";
import { Route as rootRoute } from "./routes/__root";
import { Route as sidebarRoute } from "./routes/_sidebar";
import { Route as indexRedirectRoute } from "./routes/_sidebar/index";
import { Route as reviewsIndexRoute } from "./routes/_sidebar/reviews";
import { Route as codeReviewRepoRoute } from "./routes/_sidebar/code-review-repo";
import { Route as codeReviewPRRoute } from "./routes/_sidebar/code-review-pr";
import { Route as ticketsIndexRoute } from "./routes/_sidebar/tickets";
import { Route as ticketsDetailRoute } from "./routes/_sidebar/tickets-detail";
import { Route as settingsRoute } from "./routes/settings";

const routeTree = rootRoute.addChildren([
  sidebarRoute.addChildren([
    indexRedirectRoute,
    reviewsIndexRoute,
    codeReviewRepoRoute,
    codeReviewPRRoute,
    ticketsIndexRoute,
    ticketsDetailRoute,
  ]),
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
