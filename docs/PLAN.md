# Development plan

Goal: replace Agent Knock Knock (AKK) on this setup with a small plugin that
lets OpenClaw drive coding agents running in Herdr, using Herdr's own agent
lifecycle instead of parsing terminal screens.

Non-goals for v1: tmux support, approval auto-answering, model switching,
multi-machine (`herdr --machine`) targets, Windows named pipes.

## Why this exists

On 2026-09-17 AKK 0.13.4 failed three independent ways against this host
(Herdr 0.9.1, Claude Code 2.1.274, OpenClaw 2026.9.2):

1. Exact version gate: AKK pinned Herdr `0.8.0`/protocol 19; Herdr had
   self-updated to `0.9.1`/protocol 22, so every Herdr pane was invisible.
2. Screen classifier drift: Claude Code 2.1.274 added a `user@host path` line
   under the composer. AKK's List accepted it and advertised `send`, its final
   revalidation rejected it, so sends died with "composer was not exactly empty".
3. Silent callback loss: the prompt was delivered and Claude finished in 90 s,
   but AKK's transcript-based completion detector fails closed on any
   `stop_hook_summary` record (the user has a Stop hook), so the watch stayed
   mute until its 12-hour timeout.

Herdr already classifies agents (`idle`, `working`, `blocked`, `done`,
`unknown`) with rules it updates over the air, exposes `agent.prompt`,
`agent.wait` and `events.subscribe`, and promises JSON clients that unknown
fields are ignorable. Building on that removes all three failure classes.

## Milestones

### M0 — Skeleton (done in this commit)

- Socket client (one request per connection, streaming subscription).
- Command grammar, target resolution, formatting.
- Durable watch store + event-driven watcher with restart recovery.
- OpenClaw entry: `/herdr` command, five `herdr_*` tools, watcher service.
- Unit tests for every pure module; fake Herdr server for the client.
- Read-only live smoke script.

### M1 — First live loop on operator-host

- [x] `openclaw plugins install --link --accept-capabilities ~/Projects/openclaw-herdr` on the host, restart Gateway (2026-09-20).
- [x] `/herdr`, `/herdr list` and `/herdr status` from Telegram show the Claude pane Herdr sees (2026-09-20).
- [x] Compact pane output for phone-width code blocks (strip dividers, footer chrome, empty composer, right-aligned hints).
- [ ] `/herdr w6:p1: reply with exactly OK` sends; a `[Herdr watch event]` reaches Telegram within seconds of Claude going idle.
- [ ] Confirm the wake path: does `enqueueNextTurnInjection` + `requestHeartbeat` deliver a message without the user speaking first? If not, evaluate `runtime.agent.runCommandFromIngress` or a plugin-owned gateway method, as AKK does.
- [ ] Confirm `agent.prompt` on Claude Code 2.1.278 submits in one shot (bracketed paste + Enter) with a multi-line prompt.
- [ ] Log every Herdr error code seen (`agent_blocked`, `agent_prompt_stalled`, `timeout`, ...) into docs/HERDR_API.md.

### M1.5 — Reliability hardening (from the 2026-09-20 code review)

Source: [docs/reviews/2026-09-20-code-review.es.md](reviews/2026-09-20-code-review.es.md) (Spanish, verbatim). Eleven findings, five reproduced with fakes. Verdict: architecture is right, the asynchronous state model is not yet trustworthy for unattended use. Work is split into three independent streams by file ownership.

Stream A — watcher core (`watcher.ts`, `watch-store.ts`, `runtime.ts` send/watch/unwatch):
- [x] F1 send-before-subscribe loss window: subscribe and confirm first, then prompt, then reconcile with `agent.get` (`state_change_seq` before/after); never invent `working`; reconcile on start and reconnect.
- [x] F2 `working → unknown → idle` loses completion: persist `sawWorking` separately from `lastStatus`.
- [x] F3 failed notifications: persist a pending delivery with backoff; remove the watch only after delivery.
- [x] F4 concurrent handlers: per-watch serialization, single exclusive settlement (`done` + `pane.exited` produced two notifications).
- [x] F5 unhandled rejections from `void` promises; `stop()` awaits in-flight work.
- [x] F7 replacing a watch leaks the old subscription.
- [x] F8 unknown status strings settle as "finished": validate at runtime.
- [x] F9 `seqAtStart`/`terminalId` unused: fence stale events and occupant changes via `agent.get`.
- [x] F10 one watch per pane overwrites other sessions: one watch per (pane, session); `unwatch` is caller-scoped.
- [x] Store validation: skip invalid records, quarantine corrupt JSON.
- [x] Send outcomes: "not sent" vs "sent, tracking failed" vs "uncertain".

Stream B — targets, grammar, formatting (`targets.ts`, `parse.ts`, `compact.ts`, `format.ts`):
- [x] F6 exact-match ambiguity falls through to kind match: strict precedence pane id → terminal id → name → kind, ambiguity refused per level.
- [x] Parser: clamp `read` lines to 1–400, reserved commands with bad arguments become errors, not prompts.
- [x] Character budget and backtick escaping for pane blocks; long-line truncation.
- [x] Blocked notification text must not promise remote answering until it exists.

Stream C — transport, notifier, typing (`client.ts`, `framing.ts`, `notifier.ts`, `host-api.ts`, `index.ts`, `tsconfig.json`):
- [x] Subscription `ready` ack with timeout; decoder buffer cap; wait-aware request timeouts; result shape validation.
- [x] Notifier checks `enqueued`, per-event idempotency keys, always requests a heartbeat.
- [x] `HostApi` derived from the installed SDK types instead of `as unknown as`.
- [x] Type-check tests; smoke fails loudly on subscription errors.

After merge (owner: maintainer):
- [ ] F11 live loop from Telegram (first attempt on 2026-09-20 15:11 proved send and idle detection work but heartbeat never produced a chat turn; delivery now goes through `chat.send`, retest pending): send, finish, repeated block, Gateway restart, recovery, with no extra user interaction.
- [ ] Align README, messages and limits with what was verified; then continue to M2.

### M2 — Robustness

- [ ] Reconnect subscription with backoff and re-sync state via `agent.get` after a Herdr server restart or live handoff.
- [ ] Ignore stale events using `state_change_seq` (fence on `seqAtStart`).
- [ ] Map `unknown` to a visible "Herdr cannot classify this pane" message, never to a guess.
- [ ] `blocked` notifications include the exact question text; `/herdr <pane>: <answer>` sends the answer with `agent.send_keys` when it is a menu, `agent.prompt` when it is free text.
- [ ] Watch deadline sweep test with a fake clock; idempotent notifications after restart.
- [ ] Decide whether to move to `defineToolPlugin`/feature contracts so `openclaw plugins validate` and `pack` work (they only understand those authoring forms; legacy `definePluginEntry` plugins like AKK install fine without them).

### M2.5 — Remote Herdr servers (multi-machine)

Motivation: monitor and, when explicitly allowed, drive agents in a Herdr
running on another machine (first case: `labbox`, Herdr 0.9.0 / protocol 22,
socket owned by a different Unix user, mode 0600).

Verified facts: the Herdr socket API has no machine routing field; the CLI's
`--machine` forwarding runs over SSH and exposes no event stream. Keeping
`events.subscribe` therefore requires a local Unix-socket proxy to the remote
socket. A one-off SSH bridge already reached `ping`, `agent.list` and a
`subscription_started` ack from this host.

Design decisions:
- Target grammar becomes `selector[@server]`: `w1:p1@labbox` (canonical),
  `trabajo@labbox` (Herdr agent name), `claude@labbox` (kind, only if unique).
  No `@server` means the default server (`local`), so existing usage keeps
  working and a new machine never silently changes a destination.
- `@server` is a configured alias, never a hostname typed in chat.
- A `kind:name` prefix is deferred: it would give the colon a third meaning
  next to pane ids and the prompt separator, for little gain now that watches
  fence on `terminal_id`.
- A watch is stored as `{serverId, paneId, terminalId, sessionKey}`; `unwatch`
  and target resolution are server-scoped. Ambiguity is refused per level as today.
- `/herdr list` groups by server and prints copyable references (`w3:p1@labbox`).
- Per-server `allowSend` (default `false` for non-local servers): remote
  monitoring is opt-in for reads, sending prompts to another user's agents is
  a deliberate privilege and must be enabled explicitly.
- Remote pane output enters the chat exactly like local output; same trust
  boundary, now spanning another machine and user.

Tasks:
- [ ] Config: `servers: { local: { socketPath }, labbox: { socketPath, allowSend, label } }`; keep the flat `socketPath` as an alias for `servers.local`.
- [ ] Parser/targets: accept `@server` (split on the last `@`), keep `w6:p1: prompt` working, reject unknown aliases with the configured list.
- [ ] Runtime: one `HerdrClient` per server; list grouped by server; status/read/send/watch/unwatch carry `serverId`; enforce `allowSend`.
- [ ] Store/watcher: `serverId` in `WatchRecord` (migrate old records to `local`); subscriptions keyed by server + pane; reconcile per server on reconnect.
- [ ] Health: periodic `ping` per server; a server that fails is shown as `down` in `/herdr list` and its watches stay pending until it returns.
- [ ] Tunnel: user unit `herdr-tunnel-<server>.service` running `ssh -N -L <local.sock>:<remote.sock> <user>@<host>` with `StreamLocalBindUnlink=yes`, `ExitOnForwardFailure=yes`, `ServerAliveInterval=15`, `Restart=always`; local socket mode 0600; documented in README with the alice-owned-socket caveat.
- [ ] Degraded mode note: without a tunnel, `herdr --machine <alias> agent wait <target> --until idle` gives a blocking wait; documented as fallback only.
- [ ] Tests: unknown alias, same pane id on two servers, ambiguous names across servers, `allowSend` refusal, tunnel down then back (reconcile), migration of pre-2.5 watch records.
- [ ] Live validation from Telegram: `/herdr list`, `/herdr status w3:p1@labbox`, a watch on a remote Codex that finishes, SSH drop and recovery.

### M3 — Operator ergonomics

- [ ] `/herdr start <kind> [--cwd path]` using `agent.start` in a new pane (`pane.split` / `workspace.create`).
- [ ] Short aliases: remember the last target per chat session so `/herdr <prompt>` works with several agents open.
- [ ] Optional `herdr integration install claude|codex` so Herdr reports native session ids; show them in `/herdr status`.
- [ ] Spanish/English message table (the operator chats in Spanish).

### M4 — Release

- [ ] Publish to npm as `openclaw-herdr` and to ClawHub.
- [ ] Changelog, semver, GitHub release workflow.
- [ ] Remove AKK from the host; keep `~/.openclaw/patches/` as history only.

## Risks and how they are handled

| Risk | Mitigation |
| --- | --- |
| Herdr changes a method or field | Client ignores unknown fields; each method call is one small typed helper; smoke script runs on install. No exact version pin. |
| Herdr cannot classify a new Claude/Codex UI | Herdr updates detection rules OTA (`~/.local/state/herdr/agent-detection/remote/*.toml`); we surface `unknown` instead of guessing. |
| `agent.wait`/events track state, not turns | A watch requires seeing `working` before accepting `idle`/`done`; sequence fence planned in M2. |
| Wake path does not deliver proactively | Verified in M1 before anything else; fallback documented. |
| Bypass-permissions agents run whatever is sent | Command requires an authorized sender; tools are optional and only reachable by the session owner's agent. |

## Working agreements

- Language: TypeScript on Node 24.16+ (OpenClaw's floor), no runtime dependencies beyond `typebox`.
- Tests: `npm test` (vitest) must pass before every commit; `npm run smoke` before every install on the host.
- Commits: Conventional Commits, English, subject line only.
- Never parse terminal screens in this repo. If Herdr does not expose it, propose it upstream (github.com/herdrdev/herdr).
