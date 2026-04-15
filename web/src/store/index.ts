import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppStore } from "./types";
import { createAppSlice } from "./app-slice";
import { createPullsSlice } from "./pulls-slice";
import { createPrDetailSlice } from "./pr-detail-slice";
import { createPollStatusSlice } from "./poll-status-slice";
import { createFixJobsSlice } from "./fix-jobs-slice";
import { createNotificationsSlice } from "./notifications-slice";
import { createUiSlice } from "./ui-slice";
import { createTicketsSlice } from "./tickets-slice";

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
