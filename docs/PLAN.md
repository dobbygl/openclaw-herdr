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

- [ ] `openclaw plugins install ~/Projects/openclaw-herdr` on the host, restart Gateway.
- [ ] `/herdr list` from Telegram shows the Claude pane Herdr sees.
- [ ] `/herdr w6:p1: reply with exactly OK` sends; a `[Herdr watch event]` reaches Telegram within seconds of Claude going idle.
- [ ] Confirm the wake path: does `enqueueNextTurnInjection` + `requestHeartbeat` deliver a message without the user speaking first? If not, evaluate `runtime.agent.runCommandFromIngress` or a plugin-owned gateway method, as AKK does.
- [ ] Confirm `agent.prompt` on Claude Code 2.1.278 submits in one shot (bracketed paste + Enter) with a multi-line prompt.
- [ ] Log every Herdr error code seen (`agent_blocked`, `agent_prompt_stalled`, `timeout`, ...) into docs/HERDR_API.md.

### M2 — Robustness

- [ ] Reconnect subscription with backoff and re-sync state via `agent.get` after a Herdr server restart or live handoff.
- [ ] Ignore stale events using `state_change_seq` (fence on `seqAtStart`).
- [ ] Map `unknown` to a visible "Herdr cannot classify this pane" message, never to a guess.
- [ ] `blocked` notifications include the exact question text; `/herdr <pane>: <answer>` sends the answer with `agent.send_keys` when it is a menu, `agent.prompt` when it is free text.
- [ ] Watch deadline sweep test with a fake clock; idempotent notifications after restart.
- [ ] Decide whether to move to `defineToolPlugin`/feature contracts so `openclaw plugins validate` and `pack` work (they only understand those authoring forms; legacy `definePluginEntry` plugins like AKK install fine without them).

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

- Language: TypeScript on Node 22+, no runtime dependencies beyond `typebox`.
- Tests: `npm test` (vitest) must pass before every commit; `npm run smoke` before every install on the host.
- Commits: Conventional Commits, English, subject line only.
- Never parse terminal screens in this repo. If Herdr does not expose it, propose it upstream (github.com/herdrdev/herdr).
