# Changelog

## Unreleased

- Remote Herdr machines (M2.5): machines are discovered from `herdr machine list --json`, not configured; a `selector@server` target grammar (`w1:p1@buildbox`); a new SSH stdio transport speaks Herdr's socket protocol over `ssh <target> socat - UNIX-CONNECT:<sock>` with `ControlMaster` multiplexing; `/herdr list` groups by server and shows unreachable machines as `down` with a short reason; remote machines are read-only until listed in `remote.allowSend`; watches carry a `serverId` and reconnect/reconcile the same way locally and remotely.
- Reliability hardening from the 2026-09-20 review: subscribe-before-prompt with `agent.get` reconciliation, persisted pending deliveries with retry, per-watch event serialization and exclusive settlement, occupant/sequence fencing, one watch per (pane, session), store validation and quarantine.
- Strict target precedence (pane id → terminal id → name → kind) with ambiguity refused per level; bounded grammar with explicit errors; character budgets and backtick neutralization for pane blocks.
- Transport: subscription ack with timeout, decoder buffer cap, wait-aware request timeouts, result shape validation.
- Notifications now run a Gateway `chat.send` turn (in-process or via the CLI) instead of relying on heartbeat; per-event idempotency keys.
- Types derived from the installed OpenClaw SDK; tests are type-checked.

- Compact pane output for phone-width chat clients; bold pane ids; shortened home paths.
- Initial skeleton: Herdr socket client, `/herdr` command, `herdr_*` tools, event-driven watcher with durable state, tests, docs.
