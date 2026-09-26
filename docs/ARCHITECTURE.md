# Architecture

```text
Telegram / WebChat / CLI
        │  /herdr …  or  herdr_* tool call
        ▼
OpenClaw Gateway ──(in-process plugin)──► openclaw-herdr
                                            │  src/openclaw/   command + tools + notifier
                                            │  src/core/       parse · targets · servers · watcher · store
                                            │  src/herdr/      socket client (JSON lines) + ssh stdio transport
                                            ▼
                              ┌─────────────┴─────────────┐
                              ▼                            ▼
                   ~/.config/herdr/herdr.sock     ssh <user>@<host> ──►
                              │                    socat - UNIX-CONNECT:<sock>
                              ▼                            ▼
                     Herdr server (Rust)          Herdr server (Rust), remote
                              │  agent detection, panes, prompts
                              ▼
                     Claude Code · Codex · … in panes (local or remote)
```

One `HerdrClient` per server: `local` connects to the Unix socket directly,
each configured machine connects over the SSH stdio transport instead. Both
sides speak the exact same newline-delimited JSON protocol.

## Modules

| Path | Responsibility |
| --- | --- |
| `src/herdr/framing.ts` | Newline-delimited JSON encode/decode. Pure. |
| `src/herdr/client.ts` | `HerdrClient`: one connection per request (Herdr closes after answering), one streaming connection per subscription, typed helpers for the handful of methods used. |
| `src/herdr/connection.ts` | `DuplexLike`/`ConnectionFactory`: the transport seam `HerdrClient` consumes, satisfied by a local `net.Socket` or by an `ssh` child's stdio. |
| `src/herdr/ssh-stdio.ts` | Remote transport: speaks the Herdr socket protocol over `ssh <target> socat - UNIX-CONNECT:<sock>`, with `ControlMaster` multiplexing and ssh-failure classification. (A python3 bridge exists in the transport for hosts without `socat`, but no plugin config key selects it yet.) |
| `src/herdr/machines.ts` | Machine catalog: `herdr machine list --json` and `ssh <target> herdr status server`, each behind a TTL cache. |
| `src/herdr/types.ts` | Hand-written types for those methods, taken from `herdr api schema --json` (protocol 22). |
| `src/core/parse.ts` | `/herdr` grammar → `HerdrCommand`; also splits a target into `selector` and an optional `@server`. |
| `src/core/targets.ts` | Selector → exactly one live agent (within one server's `agent.list`), or a precise refusal. |
| `src/core/i18n.ts` | Typed English and Spanish catalogs of every chat sentence; the `language` setting's parser. See ADR 0005. |
| `src/core/labels.ts` | Joins `agent.list` with `tab.list` so an agent carries its operator-assigned tab label; display-name precedence (agent name, then tab label). |
| `src/core/servers.ts` | `ServerRegistry`: which Herdr servers exist (`local` plus every discovered machine), one `HerdrClient` per server, health tracking and the `remote.allowSend` gate. |
| `src/core/watch-store.ts` | Durable JSON list of watches in the plugin state dir; each record carries a `serverId`. |
| `src/core/watcher.ts` | Subscribes to `pane.agent_status_changed` per watched (server, pane), notifies on `idle`/`done`/`blocked`/exit/timeout, reconnects; resolves its Herdr client per watch through the registry. |
| `src/core/format.ts` | Chat-ready text. Short lines, phone first; groups `/herdr list` by server. |
| `src/openclaw/runtime.ts` | Orchestrates the above for both surfaces; resolves `selector[@server]` targets against the right server. |
| `src/openclaw/commands.ts` | Registers `/herdr`. |
| `src/openclaw/tools.ts` | Registers `herdr_list`, `herdr_send`, `herdr_read`, `herdr_watch`, `herdr_status`. |
| `src/openclaw/notifier.ts` | Delivers a watch result to the originating session (`enqueueNextTurnInjection` + `requestHeartbeat`). |
| `src/index.ts` | `definePluginEntry` wiring. |

## Lifecycle of one send

1. User: `/herdr w6:p1: run the tests`.
2. `parse` → `{send, target:"w6:p1", text}`; `targets` resolves against a fresh `agent.list` enriched with `tab.list` labels.
3. If the agent is `blocked`, refuse and show the pane tail.
4. Store a `WatchRecord` (`serverId`, pane, session key, deadline,
   `state_change_seq`, `terminal_id`) and open — and confirm — the
   subscription for that pane *before* `agent.prompt`, so a fast agent cannot
   finish unobserved. `serverId` is `local` unless the target carried a
   `@server` suffix; it is what routes the watch back to the right client on
   reconnect and what qualifies the notification's `w1:p1@buildbox` ref.
5. `agent.prompt`. Then one `agent.get`: if the sequence advanced and the agent
   is idle/done, the task already ran and settles now. A transport error during
   the prompt is reported as uncertain, never as "not sent".
6. On `working → idle|done`: read the last lines, enqueue the notification into
   the originating session, request a heartbeat, drop the watch once delivery
   succeeded. On `blocked`: notify, keep the watch. On pane exit, occupant
   change or deadline: notify, drop. Events never settle a watch on their own;
   `agent.get` confirms status, occupant and sequence first.
7. Gateway restart: the service reloads the store, resubscribes and reconciles
   every watch against `agent.get`. Undelivered notifications are persisted and
   retried with backoff.

## What is deliberately absent

- No polling loop, no screen regexes. (Child processes do exist: one `ssh`
  per remote request/subscription, plus `herdr machine list --json` and the
  `openclaw` CLI notifier fallback — see `src/herdr/ssh-stdio.ts` and ADR
  0004.)
- No exact Herdr/Claude/Codex version pins.
- No approval automation and no key injection into unknown UIs.
- No tunnel service, no local socket file for a remote machine, no TCP: the
  remote transport is `ssh` stdio only.
