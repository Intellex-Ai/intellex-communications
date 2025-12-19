# Intellex Communications

Email and notification templates, provider adapters, and schedulers for user-facing comms.

## Scope
- House shared templates (move current `email-templates` here) and provider-specific metadata.
- Delivery adapters (Resend/SMTP today; room for SMS/push later) with a consistent send API.
- Digest/scheduler jobs for research updates and plan changes.
- Webhook handlers for provider events (bounces, spam, delivered).

## Repo layout
- `templates/` — email/layout assets and JSON metadata per provider.
- `src/providers/` — provider adapters and webhooks.
- `src/workflows/` — message composition, routing, and fallbacks.
- `src/jobs/` — scheduled digests and retries (can be triggered by orchestrator/API).
- `src/contracts/` — payload contracts for send requests and provider events.
- `scripts/` — template sync/publish tools.
- `tests/` — render/delivery tests.

## Environment
- Copy `.env.example` to `.env` and set:
  - `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, `EMAIL_WEBHOOK_SECRET` (Resend webhook signing secret)
  - `COMMUNICATIONS_API_SECRET` (required for `/send` and API event forwarding)
  - `PORT` and `BIND_HOST` (optional; defaults `8700` and `0.0.0.0`)
  - `API_BASE_URL` (for routing delivery events to the API)
  - `COMMUNICATIONS_BASE_URL` (self base URL for webhooks)
  - `REDIS_URL` if using async queueing
  - `LOG_LEVEL`

## Workflow
1) Author/update templates; run render checks locally.
2) Sync templates to providers; publish a versioned bundle for `intellex-api`/`intellex-orchestrator` to call.
3) Expose a thin HTTP/queue interface for send requests and event callbacks.

## Next actions
- Move existing `email-templates` content into `templates/` and add render tests.
- Define the send contract (payload + tracing) shared with `intellex-api`.
- Add provider choice/config docs and a sync script to keep templates consistent.

## Runtime
- Express + TypeScript service (entry `src/index.ts`) exposing:
  - `POST /send` — accepts `SendRequest` from `src/contracts/send.ts` and sends via Resend (shared secret + rate limiting enforced).
- `POST /webhooks/provider` — provider events (verifies Resend `resend-signature` using `EMAIL_WEBHOOK_SECRET`).
  - `GET /health` — liveness check.
- Templates are loaded from `templates/` and rendered by simple `{{ .Key }}` replacement.

## Local dev
1) `npm install`
2) Copy `.env.example` to `.env` and fill required vars.
3) `npm run dev` (defaults to port `8700`).

## Notes
- `EMAIL_PROVIDER_KEY` must be a Resend API key and `EMAIL_FROM` must be a verified sender/domain.
- Webhook and send events are forwarded to `intellex-api` (`/communications/messages` and `/communications/events`) when `API_BASE_URL` is set.
