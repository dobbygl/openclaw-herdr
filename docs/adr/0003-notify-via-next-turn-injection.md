# ADR 0003: Deliver watch results through a heartbeat turn in the originating session

Date: 2026-09-20 · Status: accepted (third revision, supersedes both earlier
versions of this ADR from the same day)

## Context

A finished or blocked agent must reach the chat that asked, promptly, even
after a Gateway restart, and without duplicates.

Two mechanisms were tried and disproved on a real host:

1. `enqueueNextTurnInjection` plus `requestHeartbeat`. The injection was
   queued and the wake requested, but no turn ran and nothing reached the
   chat: with no periodic heartbeat configured, a wake request is not a
   delivery mechanism, and a queued injection only surfaces when the user
   speaks next.
2. The Gateway method `chat.send` with `deliver: true`, in-process or through
   the `openclaw` CLI. The Gateway refused it: "Gateway requests are only
   available to bundled or trusted official plugins". That boundary is
   deliberate. `chat.send` can write into any conversation, and there is no
   safe way to trust a single local plugin with it.

## Decision

1. Persist a pending delivery on the watch record before any attempt.
2. Queue a next-turn injection in the originating session as durable context
   (idempotency key `herdr:<watchId>:<status>:<notificationSeq>`; a key hit is
   not an error).
3. Run one turn in that session right away with the public heartbeat runtime,
   `api.runtime.system.runHeartbeatOnce({ sessionKey, agentId, reason,
   heartbeat: { target: "last" } })`. The turn consumes the injection and
   delivers its reply to the session's last active channel. Only
   `status: "ran"` counts as delivered. `skipped` (session busy, cooldown)
   and `failed` throw, so the watcher retries with backoff until the watch
   deadline.
4. No `chat.send`, no CLI fallback, no request to make the plugin "trusted".

## Consequences

- Delivery uses only APIs available to local plugins, and works whether or
  not periodic heartbeats are configured.
- A busy session defers the message instead of losing it; the retry is
  idempotent through the injection key and `notificationSeq`.
- The message is produced by the agent relaying the injected text, so wording
  is the agent's; the injection asks for an as-is, phone-friendly relay.
