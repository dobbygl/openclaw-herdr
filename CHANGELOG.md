# Changelog

## Unreleased

- Reliability hardening from the 2026-09-20 review: subscribe-before-prompt with `agent.get` reconciliation, persisted pending deliveries with retry, per-watch event serialization and exclusive settlement, occupant/sequence fencing, one watch per (pane, session), store validation and quarantine.
- Strict target precedence (pane id → terminal id → name → kind) with ambiguity refused per level; bounded grammar with explicit errors; character budgets and backtick neutralization for pane blocks.
- Transport: subscription ack with timeout, decoder buffer cap, wait-aware request timeouts, result shape validation.
- Notifications now run a Gateway `chat.send` turn (in-process or via the CLI) instead of relying on heartbeat; per-event idempotency keys.
- Types derived from the installed OpenClaw SDK; tests are type-checked.

- Compact pane output for phone-width chat clients; bold pane ids; shortened home paths.
- Initial skeleton: Herdr socket client, `/herdr` command, `herdr_*` tools, event-driven watcher with durable state, tests, docs.
