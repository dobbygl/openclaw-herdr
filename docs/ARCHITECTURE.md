# Architecture

```text
Telegram / WebChat / CLI
        │  /herdr …  or  herdr_* tool call
        ▼
OpenClaw Gateway ──(in-process plugin)──► openclaw-herdr
                                            │  src/openclaw/   command + tools + notifier
                                            │  src/core/       parse · targets · watcher · store
                                            │  src/herdr/      socket client (JSON lines)
                                            ▼
                                 ~/.config/herdr/herdr.sock
                                            │
                                         Herdr server (Rust)
                                            │  agent detection, panes, prompts
                                            ▼
                                 Claude Code · Codex · … in panes
```

## Modules

| Path | Responsibility |
| --- | --- |
| `src/herdr/framing.ts` | Newline-delimited JSON encode/decode. Pure. |
| `src/herdr/client.ts` | `HerdrClient`: one connection per request (Herdr closes after answering), one streaming connection per subscription, typed helpers for the handful of methods used. |
| `src/herdr/types.ts` | Hand-written types for those methods, taken from `herdr api schema --json` (protocol 22). |
| `src/core/parse.ts` | `/herdr` grammar → `HerdrCommand`. |
| `src/core/targets.ts` | Selector → exactly one live agent, or a precise refusal. |
| `src/core/watch-store.ts` | Durable JSON list of watches in the plugin state dir. |
| `src/core/watcher.ts` | Subscribes to `pane.agent_status_changed` per watched pane, notifies on `idle`/`done`/`blocked`/exit/timeout, reconnects. |
| `src/core/format.ts` | Chat-ready text. Short lines, phone first. |
| `src/openclaw/runtime.ts` | Orchestrates the above for both surfaces. |
| `src/openclaw/commands.ts` | Registers `/herdr`. |
| `src/openclaw/tools.ts` | Registers `herdr_list`, `herdr_send`, `herdr_read`, `herdr_watch`, `herdr_status`. |
| `src/openclaw/notifier.ts` | Delivers a watch result to the originating session (`enqueueNextTurnInjection` + `requestHeartbeat`). |
| `src/index.ts` | `definePluginEntry` wiring. |

## Lifecycle of one send

1. User: `/herdr w6:p1: run the tests`.
2. `parse` → `{send, target:"w6:p1", text}`; `targets` resolves against a fresh `agent.list`.
3. If the agent is `blocked`, refuse and show the pane tail. Otherwise `agent.prompt`.
4. Store a `WatchRecord` (pane, session key, deadline, `state_change_seq`) and open a subscription for that pane.
5. On `working → idle|done`: read the last lines, enqueue the notification into the originating session, request a heartbeat, drop the watch. On `blocked`: notify, keep the watch. On pane exit or deadline: notify, drop.
6. Gateway restart: the service reloads the store and resubscribes.

## What is deliberately absent

- No polling loop, no child processes, no screen regexes.
- No exact Herdr/Claude/Codex version pins.
- No approval automation and no key injection into unknown UIs.
