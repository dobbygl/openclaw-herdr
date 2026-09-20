# ADR 0003: Deliver watch results through next-turn injection plus heartbeat

Date: 2026-09-20 · Status: proposed (validate in M1)

## Context

A finished or blocked agent must reach the chat that asked, promptly, even
after a Gateway restart, and without duplicates.

## Decision

`api.session.workflow.enqueueNextTurnInjection` with an idempotency key per
(watch, status), then `api.runtime.system.requestHeartbeat` so the session runs
a turn now instead of waiting for the user.

## Open question

Whether the heartbeat reliably produces a visible chat message on this
host's Telegram session. If not, fall back to a plugin-owned gateway method
invoked from the watcher, as AKK did, or `runtime.agent.runCommandFromIngress`.
