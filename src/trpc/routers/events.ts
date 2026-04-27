import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { subscribeTrpcEvents } from "../events.js";
import { trpc } from "../trpc.js";

const eventFilterSchema = z.object({
  events: z.array(z.string()).optional(),
});

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS2742 declaration naming issue in editor diagnostics.
export const eventProcedures = {
  events: trpc.procedure.input(eventFilterSchema.optional()).subscription((opts) => {
    const allow = new Set(opts.input?.events ?? []);
    const shouldFilter = allow.size > 0;
    return observable<{ event: string; data: unknown; at: number }>((emit) => {
      const unsubscribe = subscribeTrpcEvents((payload) => {
        if (shouldFilter && !allow.has(payload.event)) return;
        emit.next(payload);
      });
      return () => {
        unsubscribe();
      };
    });
  }),
};
