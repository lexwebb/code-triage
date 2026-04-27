import { z } from "zod";
import { getVapidKeys } from "../../vapid.js";
import { savePushSubscription, deletePushSubscription, mutePR as dbMutePR, unmutePR as dbUnmutePR, getMutedPRs as dbGetMutedPRs } from "../../push-db.js";
import { sendTestPush } from "../../push.js";
import { trpc } from "../trpc.js";

const pushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});
const pushEndpointSchema = z.object({
  endpoint: z.string(),
});
const pushMuteSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
});

export const pushProcedures = {
  pushVapidPublicKey: trpc.procedure.query(() => {
    const keys = getVapidKeys();
    return { publicKey: keys.publicKey };
  }),
  pushSubscribe: trpc.procedure.input(pushSubscriptionSchema).mutation((opts) => {
    savePushSubscription({
      endpoint: opts.input.endpoint,
      keys: { p256dh: opts.input.keys.p256dh, auth: opts.input.keys.auth },
    });
    return { ok: true };
  }),
  pushUnsubscribe: trpc.procedure.input(pushEndpointSchema).mutation((opts) => {
    deletePushSubscription(opts.input.endpoint);
    return { ok: true };
  }),
  pushMute: trpc.procedure.input(pushMuteSchema).mutation((opts) => {
    dbMutePR(opts.input.repo, opts.input.number);
    return { ok: true };
  }),
  pushUnmute: trpc.procedure.input(pushMuteSchema).mutation((opts) => {
    dbUnmutePR(opts.input.repo, opts.input.number);
    return { ok: true };
  }),
  pushMuted: trpc.procedure.query(() => ({ muted: dbGetMutedPRs() })),
  pushTest: trpc.procedure.mutation(() => {
    sendTestPush();
    return { ok: true };
  }),
};
