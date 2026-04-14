# Tab Badge Notification Design

**Date:** 2026-04-14
**Status:** Draft

## Problem

When the Code Triage web UI is open in a background tab, there's no visual indication that items need attention. The user has to manually switch to the tab and check.

## Solution

Dynamic favicon badge (count overlay) and title prefix that reflect the number of items needing user attention. Both update reactively from existing store state — no backend changes needed.

## What Counts

The badge count is the sum of:

1. **Pending triage comments** — comments with a Claude evaluation that the user hasn't acted on (replied, dismissed, fixed). Already tracked as `pendingTriage` per PR in the pull request data.
2. **Completed fix jobs** — status `"completed"` (diff ready for apply/discard).
3. **Fix jobs awaiting response** — status `"awaiting_response"` (Claude asked a question).
4. **Failed fix jobs** — status `"failed"` (needs retry or dismissal).
5. **No-changes fix jobs** — status `"no_changes"` (suggested reply to review).

Items 2-5 come from `jobs` in the Zustand store. Item 1 comes from summing `pendingTriage` across all PRs in `authored` and `reviewRequested` arrays.

## Clearing

No separate "read" tracking. The count clears naturally when the user acts on items (applies a fix, sends a reply, dismisses a comment, etc.), which removes them from the relevant store lists.

## Favicon Badge

A new utility module `web/src/lib/tab-badge.ts` exports `updateFaviconBadge(count: number)`:

- Loads the original `favicon-32.png` once into an `Image` (cached after first load).
- Draws it on a 32x32 offscreen `<canvas>`.
- If count > 0: overlays a red filled circle in the bottom-right quadrant with the count as white text. Counts above 9 display as "9+".
- Sets `document.querySelector('link[rel="icon"]').href` to the canvas `toDataURL()`.
- If count is 0: restores the original favicon href (`/favicon-32.png`).

## Title Badge

Same module exports `updateTitleBadge(count: number)`:

- If count > 0: `document.title = "(count) Code Triage"`.
- If count is 0: `document.title = "Code Triage"`.

## Wiring

A `useEffect` in `web/src/App.tsx` derives the count from store state:

```
count = pendingTriageTotal
  + jobs.filter(j => ["completed", "awaiting_response", "failed", "no_changes"].includes(j.status)).length
```

Where `pendingTriageTotal` is the sum of `pendingTriage` across all PRs in both `authored` and `reviewRequested`.

Calls `updateFaviconBadge(count)` and `updateTitleBadge(count)` whenever the derived count changes.

## No Backend Changes

Everything is derived from existing store state that's already kept up-to-date via SSE events and polling. No new API endpoints or SSE event types needed.
