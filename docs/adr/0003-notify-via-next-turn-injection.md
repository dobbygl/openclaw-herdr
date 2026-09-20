# ADR 0003: Deliver watch results through a Gateway `chat.send` turn

Date: 2026-09-20 · Status: accepted (supersedes the "injection plus heartbeat" proposal of the same day)

## Context

A finished or blocked agent must reach the chat that asked, promptly, even
after a Gateway restart, and without duplicates.

The first proposal was `enqueueNextTurnInjection` plus `requestHeartbeat`.
The first live run (2026-09-20 15:11, Telegram direct session) disproved it:
the injection was queued and the heartbeat requested, yet no agent turn ran
and no message reached the chat, because heartbeats are not configured on the
host and a queued injection only surfaces on the next user-initiated turn.

Agent Knock Knock, the predecessor, delivered its callbacks with the Gateway
RPC method `chat.send` (`{sessionKey, agentId, message, deliver: true,
idempotencyKey}`), which runs a turn in the target session and delivers the
reply to its channel. That path was verified working on this host.

## Decision

1. Persist a pending delivery on the watch record before any attempt.
2. Queue a next-turn injection as durable context (idempotency key
   `herdr:<watchId>:<status>:<notificationSeq>`; a key hit is not an error).
3. Primary delivery: `chat.send` with `deliver: true`, in-process through
   `runtime.gateway.request` when a Gateway request context is available,
   otherwise by spawning `openclaw gateway call chat.send`. A non-zero exit or a
   rejected request throws so the watcher retries with backoff until the watch
   deadline.
4. `requestHeartbeat` remains a best-effort extra.

## Consequences

- Delivery no longer depends on heartbeat configuration or on the user
  speaking first.
- Each logical event (a second `blocked`, the final `done`) has its own
  identity via `notificationSeq`, so host deduplication cannot swallow it.
- The CLI path adds one process per notification; acceptable at this volume.
