# Implementation plan (enhancements backlog)

Ordered backlog for **solo maintainer**, **strictly local** Code Triage: highest leverage and lowest risk first. Use this as a checklist; implement **top to bottom** unless a later item blocks something you need sooner.

**Already done:** SQLite + Drizzle persistence (`state.sqlite`, `src/db/`).

---

## Tier 1 — Foundation (do these first)

| # | Enhancement | Why this priority | Primary touchpoints | Done criteria (brief) |
|---|-------------|-------------------|---------------------|------------------------|
| 1.1 | **Automated tests for core backend** | Protects GitHub/Claude parsing and retries; enables safe refactors. | `src/exec.ts` (429 backoff, pagination helpers), `src/poller.ts` (bot filter, author filter, `isNewComment` integration), `src/actioner.ts` (`parseEvaluation` / `validateEvaluation`), `src/state.ts` + DB roundtrip | **Done (baseline):** `yarn test` (Vitest), `src/**/*.test.ts` — mocked `fetch` for `ghAsync` (object, pagination, 429), `buildIgnoredBotSet` / `filterCommentsForPoll`, exported `parseEvaluation`, SQLite roundtrip + `isNewComment` via `CODE_TRIAGE_STATE_DIR`. Extend with `ghPost` / GraphQL as needed. |
| 1.2 | **Health / readiness surface** | Makes “stuck polling” and rate limits diagnosable without reading logs. | `src/api.ts`, `src/server.ts`, optionally `src/exec.ts` for last rate-limit snapshot | **Done:** `GET /api/health` returns `status`, `uptimeMs`, `repos`, poll fields, `lastPollError`, `rateLimit`, `fixJobsRunning`, `persistedLastPoll`. `getPollState({ consumeTestNotification: false })` used so health checks do not steal the test-notification flag. |
| 1.3 | **Claude evaluation queue + concurrency cap** | Prevents overlapping `claude -p` storms when many repos/comments arrive at once. | `src/actioner.ts`, `src/cli.ts` (poll loop), possibly small `src/queue.ts` | **Done:** `evalConcurrency` in config (default 2, clamp 1–8), `--eval-concurrency`, shared FIFO worker pool in `run-with-concurrency.ts`; `analyzeComments` runs evaluations with bounded parallelism; `killAllChildren` unchanged. |

---

## Tier 2 — Reliability and product fit

| # | Enhancement | Why this priority | Primary touchpoints | Done criteria (brief) |
|---|-------------|-------------------|---------------------|------------------------|
| 2.1 | **Optional: analyze comments on review-requested PRs** | Same dashboard already lists those PRs; opt-in closes the loop without blowing up default Claude usage. | `src/config.ts`, `src/poller.ts`, `docs/config-and-state.md` | **Done:** `pollReviewRequested` + `--poll-review-requested`; `selectPollPulls` merges authored + review-requested PRs; docs/features updated. |
| 2.2 | **Cross-platform notifications** | Today macOS-only (`osascript`); Windows/Linux users get weaker alerts. | `src/notifier.ts`, `web/src/useNotifications.ts` (optional parity) | **Done:** `node-notifier` in CLI; browser notifications remain the primary rich path in `useNotifications.ts`. |
| 2.3 | **Real-time UI updates (SSE)** | Reduces reliance on `/api/poll-status` polling; nicer fix-job progress. | `src/server.ts`, `src/api.ts`, `web/src` poll hooks | **Done:** `GET /api/events`, `sseBroadcast` on poll + `setFixJobStatus`; `App.tsx` `EventSource`; demo route wired. |
| 2.4 | **State retention / compaction** | Comment map grows forever; SQLite makes pruning safe. | `src/db/client.ts`, `src/state.ts`, config | **Done:** `commentRetentionDays` + `--comment-retention-days`; `compactCommentHistory` after successful poll; `pending` preserved. |

---

## Tier 3 — UX and configurability

| # | Enhancement | Why this priority | Primary touchpoints | Done criteria (brief) |
|---|-------------|-------------------|---------------------|------------------------|
| 3.1 | **Triage UX: keyboard shortcuts + focus** | Faster loop for heavy users. | `web/src` (threads list, global shortcuts) | Documented keys (e.g. navigate thread, trigger primary action); accessible fallbacks. |
| 3.2 | **Local-only triage metadata** | Snooze, priority, or short notes without GitHub API. | `src/types.ts`, DB schema, `web` | Fields stored in SQLite; API returns them on comments; no change to GitHub unless user acts. |
| 3.3 | **Model / prompt overrides** | Per-repo or global prompt fragments; optional model CLI flag. | `src/config.ts`, `src/actioner.ts` | Config keys documented; safe defaults; secrets not logged. |

---

## Tier 4 — Hardening and scale (when needed)

| # | Enhancement | Why this priority | Primary touchpoints | Done criteria (brief) |
|---|-------------|-------------------|---------------------|------------------------|
| 4.1 | **Local server hardening** | Matters if bind address is not loopback or you expose the port. | `src/config.ts`, `src/server.ts` | `host` default `127.0.0.1`; optional `apiToken` for `POST` routes; CORS tightened when configured. |
| 4.2 | **GitHub webhooks (local)** | Lower latency than poll; requires tunnel or small local forwarder. | New small module + config | Document-only or minimal prototype: user runs tunnel; app validates signature; falls back to poll. **Low priority** for “never deploy” persona. |
| 4.3 | **Typed GitHub client (e.g. Octokit)** | Reduces hand-written REST shapes when endpoints multiply. | `src/exec.ts`, call sites | Adopt incrementally; no regression in retry/pagination behavior. |

---

## Suggested execution rhythm

1. Finish **Tier 1** before large feature work (tests especially).
2. Pick **one row** per PR or session; avoid mixing queue changes with webhook experiments.
3. After **1.2**, wire a minimal UI hint (banner or settings line) so health is visible during dogfooding.
4. Revisit order if **2.1** becomes more valuable than **2.3** for your workflow (config flag is often cheaper than SSE).

---

## Out of scope (for this backlog)

- Multi-user hosted deployment, shared DB, or auth providers.
- Replacing Claude with another model vendor (covered only lightly under3.3 as “override hook”).

When an item ships, add a short note under it (date + PR) or move it to a “Completed” subsection so this file stays the single roadmap.
