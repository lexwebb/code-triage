import { trpc } from "./trpc.js";
import { systemProcedures } from "./routers/system.js";
import { pullProcedures } from "./routers/pulls.js";
import { actionProcedures } from "./routers/actions.js";
import { eventProcedures } from "./routers/events.js";
import { fixProcedures } from "./routers/fix.js";
import { ticketProcedures } from "./routers/tickets.js";
import { teamAttentionProcedures } from "./routers/team-attention.js";
import { metaProcedures } from "./routers/meta.js";
import { pushProcedures } from "./routers/push.js";
import { companionProcedures } from "./routers/companion.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS2742 declaration naming issue in editor diagnostics.
export const appRouter = trpc.router({
  ...systemProcedures,
  ...pullProcedures,
  ...actionProcedures,
  ...fixProcedures,
  ...ticketProcedures,
  ...teamAttentionProcedures,
  ...metaProcedures,
  ...pushProcedures,
  ...companionProcedures,
  ...eventProcedures,
});
export type AppRouter = typeof appRouter;
