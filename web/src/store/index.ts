import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppStore } from "./types";
import { createAppSlice } from "./appSlice";
import { createPullsSlice } from "./pullsSlice";
import { createPrDetailSlice } from "./prDetailSlice";
import { createPollStatusSlice } from "./pollStatusSlice";
import { createFixJobsSlice } from "./fixJobsSlice";
import { createNotificationsSlice } from "./notificationsSlice";
import { createUiSlice } from "./uiSlice";
import { createTicketsSlice } from "./ticketsSlice";

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((...a) => ({
    ...createAppSlice(...a),
    ...createPullsSlice(...a),
    ...createPrDetailSlice(...a),
    ...createPollStatusSlice(...a),
    ...createFixJobsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createUiSlice(...a),
    ...createTicketsSlice(...a),
  })),
);


export { useAppStore as default };
export type { AppStore } from "./types";
export {
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectFlatPulls,
  selectTimerText,
  selectShowNotifBanner,
  formatDurationUntil,
} from "./selectors";
