# Railway hosted plan (control plane + local runners)

This document defines a practical migration from today's local-first process to a remotely hosted web app on Railway while keeping code execution on user machines through local runners.

It is intentionally implementation-oriented: service boundaries, data model, protocol shape, rollout, and operational guardrails.

## Goals and non-goals

### Goals

- Host the web experience and orchestration in Railway.
- Keep repository access, AI tool invocation, and file edits on user machines through outbound-connected local runners.
- Preserve existing safety semantics: review diff before push by default.
- Support multi-tenant workspaces with clear auth boundaries and auditability.

### Non-goals (initial phases)

- Full hosted code editing with server-side clones.
- OpenRouter as the primary AI backend (deferred; keep pluggable interface).
- Broad command execution from cloud to runner (MVP uses constrained job types only).

## Current constraints to preserve

- Existing fix flow assumes local git worktrees and local command execution.
- Existing evaluation/fix logic already produces artifacts the UI understands (evaluation objects, diff previews, no-change and question flows).
- Existing web UI and API semantics can be evolved incrementally rather than rewritten all at once.

## Target architecture

### Components

- `web` (Railway service)
  - React app static assets and frontend routing.
- `api` (Railway service)
  - Auth, workspace APIs, runner management, job creation, job status, artifact retrieval, SSE/tRPC bridge.
- `orchestrator` (Railway worker service, always-on)
  - Queue scheduling, lease expiry, retries, cancellation propagation, watchdog tasks.
- `postgres` (Railway database)
  - Durable system of record for workspaces, runners, jobs, events, artifacts, bindings.
- `redis` (Railway database)
  - Low-latency queue primitives, lease locks, fan-out channels, short-lived status caches.
- `runner` (user machine process)
  - Outbound connection to control plane; executes `evaluate` and `fix` jobs against local repos.

### Network model

- Railway services communicate through private networking.
- Runners never accept inbound connections; they establish outbound TLS connections to `api`.
- No direct cloud access to user filesystem.

## Railway project layout

## Services

- `web`
  - Root directory: `web`
  - Build command: `yarn workspace code-triage-web build`
  - Start command: static file server command (or app server wrapper if required).
- `api`
  - Root directory: repository root
  - Build command: `yarn build`
  - Start command: dedicated server entrypoint (split from CLI path as part of migration).
- `orchestrator`
  - Root directory: repository root
  - Build command: `yarn build`
  - Start command: `node dist/orchestrator.js` (new entrypoint).
- `postgres` plugin/service
- `redis` plugin/service

## Monorepo deployment settings

- Configure watch paths so `web` changes do not redeploy `api` and vice versa.
- Keep separate environments (`staging`, `prod`) with independent databases.
- Apply usage alerts and hard limits from day one.

## Environment variable matrix (v1)

Values marked "shared" should be managed at Railway environment scope and referenced by service variables.

| Variable | web | api | orchestrator | Notes |
|----------|-----|-----|--------------|-------|
| `NODE_ENV` | yes | yes | yes | `production` in hosted envs |
| `APP_BASE_URL` | yes | yes | no | Public URL for links and callbacks |
| `API_BASE_URL` | yes | yes | yes | Internal/private URL for service calls |
| `DATABASE_URL` | no | yes | yes | Postgres connection string |
| `REDIS_URL` | no | yes | yes | Redis connection string |
| `JWT_SIGNING_KEY` | no | yes | no | Session/auth token signing |
| `RUNNER_TOKEN_SIGNING_KEY` | no | yes | yes | Runner auth and job envelope signing |
| `ENCRYPTION_KEY` | no | yes | no | At-rest encryption for sensitive fields |
| `GITHUB_APP_ID` | no | yes | no | If using GitHub App on hosted side |
| `GITHUB_APP_PRIVATE_KEY` | no | yes | no | PEM value from secret store |
| `GITHUB_WEBHOOK_SECRET` | no | yes | no | Webhook signature verification |
| `SSE_HEARTBEAT_MS` | no | yes | no | Keep-alive for UI event streams |
| `JOB_LEASE_TTL_MS` | no | yes | yes | Lease expiration for runner jobs |
| `JOB_MAX_ATTEMPTS` | no | yes | yes | Retry policy |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | yes | yes | Optional telemetry sink |

## Data model (schema v1)

Postgres access in the hosted control plane must use **Drizzle ORM**, and schema evolution must be managed through **Drizzle migrations** (generated and applied via the existing Drizzle workflow, not ad hoc SQL files).

## Core tables

- `workspaces`
  - `id`, `slug`, `name`, `created_at`
- `workspace_members`
  - `workspace_id`, `user_id`, `role`, `created_at`
- `runners`
  - `id`, `workspace_id`, `name`, `status`, `version`, `capabilities_json`, `labels_json`, `last_heartbeat_at`, `created_at`
- `runner_reg_tokens`
  - `id`, `workspace_id`, `token_hash`, `expires_at`, `used_at`, `created_by`
- `repo_bindings`
  - `id`, `workspace_id`, `runner_id`, `repo`, `local_path_hint`, `branch_policy_json`, `created_at`
- `jobs`
  - `id`, `workspace_id`, `type`, `status`, `priority`, `payload_json`, `requested_by`, `created_at`, `updated_at`
- `job_leases`
  - `job_id`, `runner_id`, `attempt`, `leased_at`, `lease_expires_at`
- `job_events`
  - `id`, `job_id`, `type`, `message`, `data_json`, `created_at`
- `job_artifacts`
  - `id`, `job_id`, `kind`, `uri`, `metadata_json`, `created_at`

## Suggested indexes

- `jobs(workspace_id, status, priority, created_at)`
- `job_leases(runner_id, lease_expires_at)`
- `runners(workspace_id, status, last_heartbeat_at)`
- unique `repo_bindings(workspace_id, runner_id, repo)`

## Job protocol (runner-facing)

## Job types in MVP

- `evaluate_comment`
  - Inputs: repo, PR number, comment metadata, diff hunk, optional runner instructions.
  - Output: evaluation object and optional raw reasoning snippet.
- `fix_comment`
  - Inputs: repo, branch, comment context, optional user instructions, push policy.
  - Output: status (`questions`, `no_changes`, `completed`), diff artifact, execution logs, validation summary.

## Lifecycle

- `queued` -> `leased` -> `running` -> `completed|failed|cancelled`
- Lease expiry returns to `queued` with `attempt + 1`.
- On attempt exhaustion (`JOB_MAX_ATTEMPTS`), set `failed_permanent`.

## Minimal endpoint surface

- `POST /v1/runners/register`
- `POST /v1/runners/:id/heartbeat`
- `POST /v1/runners/:id/lease`
- `POST /v1/jobs/:id/ack-start`
- `POST /v1/jobs/:id/progress`
- `POST /v1/jobs/:id/artifacts`
- `POST /v1/jobs/:id/complete`
- `POST /v1/jobs/:id/fail`
- `POST /v1/jobs/:id/cancel-ack`

Control plane and UI:

- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`
- `GET /v1/runners`

## Security model

- Runner registration uses short-lived one-time registration tokens.
- Runner and control plane exchange signed short-lived credentials after registration.
- Job payloads are signed; runner verifies signature and nonce freshness.
- Runner only accepts jobs for explicitly allowed repo bindings.
- No arbitrary shell execution endpoint in MVP.
- Server-side artifact redaction for obvious secret patterns before persistence/display.
- Full audit trail for job creation, execution, and push-related actions.

## Product behavior policy

Default push policy is `manual`:

- Runner can prepare diff and optional local commit metadata.
- User must explicitly confirm push from UI.

Optional future modes:

- `semi-auto`: runner can commit, push requires user click.
- `auto`: runner commit+push behind workspace admin opt-in.

## Migration strategy

### Phase 0: abstraction prep

- Introduce interfaces for queue/store/runner dispatch.
- Keep local behavior as default path while enabling hosted adapters.

### Phase 1: hosted control plane baseline

- Deploy `web`, `api`, `orchestrator`, `postgres`, `redis` on Railway staging.
- Add workspace and runner registry endpoints.
- Add job persistence and status APIs.
- Implement and apply schema changes using Drizzle ORM + Drizzle migrations.

### Phase 2: runner MVP

- Build runner daemon with heartbeat/lease loop.
- Support `evaluate_comment` end-to-end.
- Emit artifacts and progress events to UI.

### Phase 3: fix jobs and review UX

- Support `fix_comment` with worktree isolation on runner.
- Upload diff/log artifacts and show in web UI.
- Keep apply/discard/push as explicit user actions.

### Phase 4: hardening and operations

- Retry/dead-letter policies and cancellation reliability.
- Observability dashboards and alerting.
- Backpressure and queue QoS controls.
- Security review and threat model validation.

## Operational playbook (initial)

- Deploy flow: staging first, then production promotion.
- Rollback: Railway deployment rollback + feature flags for job type enablement.
- Incident controls:
  - disable runner leasing per workspace
  - disable specific job types globally
  - revoke compromised runner tokens immediately
- Capacity controls:
  - limit concurrent leases per runner/workspace
  - protect API from artifact upload bursts

## Risks and mitigations

- Runner churn/offline behavior
  - Mitigation: robust lease TTL and retry behavior; explicit stale-runner detection.
- Version skew between runner and API
  - Mitigation: protocol version handshake and minimum supported runner version gate.
- Secret leakage in logs/artifacts
  - Mitigation: redaction filters + restricted artifact access by workspace membership.
- Cost spikes from always-on services
  - Mitigation: usage alerts, hard limits, and controlled worker resource sizing.

## Deferred topics

- OpenRouter and hosted AI provider routing
- Hosted git execution without local runner
- Advanced multi-runner scheduling pools
- Organization-wide policy packs and compliance exports

## First implementation slice

Build and ship the smallest vertical slice first:

1. Railway staging project with `web`, `api`, `postgres`, `redis`.
2. Runner registration + heartbeat endpoint.
3. Lease no-op job type.
4. UI runner health panel.

This slice validates deployment architecture, auth flow, and runner connectivity before adding expensive fix execution logic.
