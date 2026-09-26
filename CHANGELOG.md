# Changelog

## Unreleased

- Reply language: a `language` setting (`en` default, `es`) localizes `/herdr` replies, tool results, usage errors, help and watch notifications, with no model call. OpenClaw exposes no trusted user language to plugins, so there is no auto-detection; the manifest accepts only `en` and `es` (the host rejects other values), and the runtime falls back to English with a warning if one gets through. Each watch persists the language of the reply that created it. Ids, names, labels, paths, command syntax, agent states and agent output are never translated. See ADR 0005.

- Operator-assigned tab labels (from `tab.list`) name agents that have no Herdr name: `/herdr list` and `status` lead with the name and keep the pane id as the secondary ref, and a label such as `sample#reviewer` (or `sample#reviewer@buildbox`) is a target between agent name and agent kind. A label on several tabs, or a tab with several agents, is refused with the candidate pane ids, by `unwatch` too. Selectors accept digits, dots and non-ASCII letters, so every label the list shows can be typed; a malformed machine-qualified target is refused instead of being sent to the only local agent. A Herdr without `tab.list` falls back to ids and names; any other `tab.list` failure is reported.

- `start` waits for a brand-new pane's shell to reach its prompt and retries Herdr's `agent_pane_busy`; a machine label shared by several saved profiles is refused with their ids instead of picking the first.

- `/herdr start <name> [kind] [pane id or cwd]` and the `herdr_start` tool (which also takes a timeout and native agent args): open a pane (or reuse an empty labelled one) and start an agent that is then addressable by name.

- Remote Herdr machines (M2.5): machines are discovered from `herdr machine list --json`, not configured; a `selector@server` target grammar (`w1:p1@buildbox`); a new SSH stdio transport speaks Herdr's socket protocol over `ssh <target> socat - UNIX-CONNECT:<sock>` with `ControlMaster` multiplexing; `/herdr list` groups by server and shows unreachable machines as `down` with a short reason; remote machines are read-only until listed in `remote.allowSend`; watches carry a `serverId` and reconnect/reconcile the same way locally and remotely.
- Reliability hardening from the 2026-09-20 review: subscribe-before-prompt with `agent.get` reconciliation, persisted pending deliveries with retry, per-watch event serialization and exclusive settlement, occupant/sequence fencing, one watch per (pane, session), store validation and quarantine.
- Strict target precedence (pane id → terminal id → name → kind) with ambiguity refused per level; bounded grammar with explicit errors; character budgets and backtick neutralization for pane blocks.
- Transport: subscription ack with timeout, decoder buffer cap, wait-aware request timeouts, result shape validation.
- Notifications run one heartbeat turn in the originating session (`runHeartbeatOnce`) after queueing the event as durable context; per-event idempotency keys. `chat.send` is not used: the Gateway reserves it for official plugins.
- Types derived from the installed OpenClaw SDK; tests are type-checked.

- Compact pane output for phone-width chat clients; bold pane ids; shortened home paths.
- Initial skeleton: Herdr socket client, `/herdr` command, `herdr_*` tools, event-driven watcher with durable state, tests, docs.
