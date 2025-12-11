# Intellex Communications

Email and notification templates, provider adapters, and schedulers for user-facing comms.

## Scope
- House shared templates (move current `email-templates` here) and provider-specific metadata.
- Delivery adapters (Resend/SMTP today; room for SMS/push later) with a consistent send API.
- Digest/scheduler jobs for research updates and plan changes.
- Webhook handlers for provider events (bounces, spam, delivered).

## Repo layout (proposed)
- `templates/` — email/layout assets and JSON metadata per provider.
- `src/providers/` — provider adapters and webhooks.
- `src/workflows/` — message composition, routing, and fallbacks.
- `src/jobs/` — scheduled digests and retries (can be triggered by orchestrator/API).
- `src/contracts/` — payload contracts for send requests and provider events.
- `scripts/` — template sync/publish tools.
- `tests/` — render/delivery tests.

## Workflow
1) Author/update templates; run render checks locally.
2) Sync templates to providers; publish a versioned bundle for `intellex-api`/`intellex-orchestrator` to call.
3) Expose a thin HTTP/queue interface for send requests and event callbacks.

## Next actions
- Move existing `email-templates` content into `templates/` and add render tests.
- Define the send contract (payload + tracing) shared with `intellex-api`.
- Add provider choice/config docs and a sync script to keep templates consistent.

## Current scaffold
- Send contract: `src/contracts/send.ts` (request/response/provider event payloads).
- Template sync stub: `scripts/sync-templates.sh` (wire to provider SDK/CLI).
