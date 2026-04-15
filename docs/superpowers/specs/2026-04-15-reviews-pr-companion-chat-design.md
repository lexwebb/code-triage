# Reviews PR Companion Chat — Design

## Summary

Add an optional **natural-language companion panel** on the code review (PR) experience that:

- Summarizes review threads that suggest **fixes** (and optionally other actionable eval types later).
- Supports **multi-turn** Q&A in the same style as other Claude-assisted flows in the app.
- Acts as a **soft companion**: it never blocks, replaces, or gates **Fix with Claude**, the fix queue, or **Apply** — those remain exactly as they are today.

The companion is for **orientation, planning in plain language, and clarification**. Execution stays in existing per-thread UI and fix-job flows.

## Goals

1. Give a **single conversational surface** to understand “what this PR is asking me to change” across many review threads.
2. Let Claude **ask clarifying questions** and incorporate user answers **without** implying those answers auto-start fixes or apply patches.
3. Preserve **full parallelism** with today’s workflow: users can ignore the panel, or use it while still starting fixes from threads, keyboard shortcuts, and the fix banner/modal.
4. Keep **clear separation** from the **per-comment fix conversation** (`FixConversation` / `awaiting_response` on a specific `commentId`).

## Non-Goals

- **No gating**: The companion must not be required before `startFix`, enqueueing the fix queue, or `applyFix`.
- **No auto-apply** from chat output: applying changes stays behind existing explicit actions (thread buttons, fix job modal, etc.).
- **No replacement** of per-thread evaluation or fix jobs; no merging of companion transcript into fix `conversation` unless a **separate, explicit** future feature defines handoff (out of scope for v1).
- **Not** a general-purpose coding agent with repo write tools from this panel alone (companion is **read/analyze/coordinate in prose** relative to thread data the UI already has).

## UX Design

### Placement

- **Where**: PR detail / reviews route — `web/src/components/code-review-detail.tsx` (or a child dedicated to the active tab).
- **When visible**: Default to **Review (threads)** tab, where the mental model matches “discussion about the PR.” Optional: also show a **collapsed entry point** (e.g. header chip or icon) on other tabs so users can open the panel without switching tabs — **v2** unless trivial.
- **Layout**: **Collapsible side panel** (e.g. right dock) or **bottom drawer** on narrow widths. Must not hide the thread list by default; companion is **secondary** chrome.
- **Empty state**: Short explanation + **suggested prompts** (chips), e.g.:
  - “Summarize all suggested fixes”
  - “What should I double-check before fixing?”
  - “Group these comments by file and risk”

### Labeling and distinction

- Panel title must distinguish it from per-thread fix chat, e.g. **“PR assistant”** or **“Review overview (chat)”**, not “Fix conversation.”
- If a per-thread fix is in **`awaiting_response`**, the thread UI remains the place to answer **that** Claude turn; the companion can **mention** that a thread needs a reply but must not claim to substitute for that UI unless we later add explicit deep links (optional v1: link to scroll-to-thread by `commentId`).

### Context freshness (soft companion, stale OK)

- Show a **context line**: e.g. “Based on **N** threads · snapshot **time**” or “Refresh context” when the client detects PR/comment data changed (simple approach: bump a counter when `comments` or `detail` identity changes in store).
- **Refresh context** button: rebuilds the structured bundle from current Zustand state and sends it on the **next** user message (or triggers a system-side “context updated” turn — implementation choice). Users should understand summaries can lag until refresh.

### Suggested prompts and input

- **Chips** insert user message text; user can edit before send.
- **Textarea** + Send; **Cmd/Ctrl+Enter** to send (match existing patterns in thread fix UI).
- Show **loading** state per assistant turn; **errors** inline with retry.

## Data Model

### Client-side “thread bundle”

Derived from existing PR detail state (`comments`, evaluations, triage fields, paths, lines, optional `diffHunk`, `crStatus`). Each row is one **root** review thread the UI already knows about.

Minimal shape (illustrative — tighten in implementation):

```ts
type CompanionThreadBundle = {
  commentId: number;
  path: string;
  line: number;
  body: string;
  diffHunk?: string;
  evaluation?: {
    action: string;
    summary?: string;
    fixDescription?: string;
    reply?: string;
  };
  crStatus?: string;
  triageNote?: string | null;
  priority?: number | null;
  isResolved?: boolean;
};
```

**Filtering for v1**: Include threads where `evaluation?.action === "fix"` **or** user toggles “include all evaluated threads” in panel settings — default **fix-only** keeps prompts focused.

**Truncation**: Large `body` / `diffHunk` must be truncated per thread with explicit “(truncated)” markers so the model does not assume full diff coverage. Cap total payload size; if over cap, prefer **most recently updated** threads and a clear system note “N threads omitted from bundle.”

### Server-side session (recommended)

Multi-turn chat with large PRs is awkward if the client must resend the entire transcript **and** full bundle every time.

- **Recommended**: Persist a **PR-scoped companion session** server-side (new SQLite table or reuse a generic `assistant_sessions` pattern if introduced).
- Fields (conceptual): `repo`, `pr_number`, `messages_json`, `bundle_json` (last refreshed snapshot), `bundle_updated_at`, `created_at`, `updated_at`.
- **Alternative MVP**: Stateless endpoint — each request sends `messages[]` + `threads[]`; acceptable for small PRs and prototypes only. Document token limits and promote session persistence before wide use.

## API Design

### Endpoints (proposed)

1. **`POST /api/reviews/companion/message`** (name TBD — align with `docs/http-api.md` when implemented)
   - **Body**: `repo`, `prNumber`, `userMessage` (string), optional `sessionId`, optional `refreshContext: boolean`.
   - If `refreshContext` or new session: client includes **compact** `threadBundle` built from current UI state; server stores as latest bundle for that session.
   - **Response**: `assistantMessage` (string), `sessionId`, optional `contextNote` (e.g. threads counted).
2. **`GET /api/reviews/companion/session?repo=&prNumber=`** (optional)
   - Returns last messages + metadata for page reload (if sessions persisted).

### Claude invocation

- New **prompt path** in backend (e.g. `src/actioner.ts` or sibling): system instructions that state:
  - You are helping triage **GitHub review threads** for one PR.
  - You **must not** claim fixes were applied or started.
  - Prefer **numbered summaries**, **questions**, and **risk callouts**; cite `commentId` when referencing a thread.
- Use existing **Claude CLI** invocation style (`claude -p`, JSON or plain text output) consistent with evaluation/fix code paths; **no** `FIX_JSON_SCHEMA` — prose is sufficient.
- Enforce **max turns per hour** / rate limits consistent with other Claude endpoints if applicable.

### Security and privacy

- Bundle may contain **code** and **reviewer text**; same trust boundary as existing fix/eval flows.
- Do not log full bundles at **info** level in production; redact or sample in logs.

## Integration with Existing Infrastructure

| Area | Pattern |
|------|--------|
| UI shell | `CodeReviewDetail` + new component e.g. `PrCompanionPanel` |
| State | Local React state + optional Zustand slice for `sessionId` / open-collapsed; or TanStack Query for session fetch |
| HTTP | `web/src/api.ts` `postJSON` pattern |
| Routes | `src/api.ts` `registerRoutes` / `addRoute`, async handler |
| Docs | Update `docs/http-api.md` when routes ship |
| Per-thread fix chat | Unchanged; document side-by-side mentally |

## Error Handling

- **Claude / CLI failure**: Inline error in panel + retry; do not affect thread list or fix jobs.
- **Oversized bundle**: Server returns **413** or **400** with message to narrow filter or refresh; client shows actionable copy.
- **Session missing** (expired): Start new session transparently with fresh bundle.

## Testing Strategy

- **Unit**: Bundle builder from mock `comments` (truncation, fix-only filter, resolved-thread exclusion).
- **API**: Handler validates repo/PR, rejects malformed body; mock Claude for CI.
- **Component**: Panel open/close, refresh context bumps snapshot label, send disables while loading.
- **Integration** (manual): Run dev stack; confirm starting a fix from a thread while companion is open still works; confirm companion does not appear in network tab as a prerequisite to `POST` fix routes.

## Rollout Plan

1. **Scaffold** collapsed panel + bundle builder + **stateless** `POST` (or session table stub) behind no user-facing flag if needed.
2. **Wire** Claude prompt path with conservative truncation and fix-only default.
3. **Persist** sessions + `GET` restore for reload (if not in MVP).
4. **Polish** suggested prompts, context line, keyboard focus, and `docs/http-api.md`.

## Open Questions (implementation time)

- Exact **session key**: `(repo, prNumber)` only, or include **head SHA** to invalidate when PR updates?
- Should v1 **include `reply` suggestions** in the default bundle, or strictly **fix**?
- **Streaming** assistant tokens: defer to v2 unless trivial with current CLI wrapper.

## Acceptance Criteria

- User can hold a **multi-turn** conversation about suggested fixes **without** any change to fix-queue or apply behavior.
- **Per-thread fix** and **companion** are **visually and functionally distinct**.
- **Refresh context** makes it obvious when the summary may be stale relative to live threads.
- Companion failure **never** blocks reviews page or thread actions.
