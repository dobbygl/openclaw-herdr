# Herdr socket API notes (protocol 22, Herdr 0.9.1)

Verified live on 2026-09-20 against `~/.config/herdr/herdr.sock`.

## Framing

- Unix domain socket, newline-delimited JSON. Request: `{"id","method","params"}`.
- Success: `{"id","result":{"type":...}}`. Error: `{"id","error":{"code","message"}}` (the id may be empty on parse errors).
- The server closes the connection after one response. `events.subscribe` is the exception: it answers `{"type":"subscription_started"}` and then streams `{"event","data"}` lines until either side closes.
- Compatibility rule stated by Herdr: clients ignore unknown fields and treat unsupported methods as ordinary errors. No version negotiation is needed for JSON clients.

## Methods used

| Method | Params | Notes |
| --- | --- | --- |
| `ping` | – | `{version, protocol, capabilities}`. Good liveness check. |
| `agent.list` | – | `agents[]` with `pane_id`, `terminal_id`, `agent`, `agent_status`, `name`, `state_change_seq`, `cwd`, `foreground_cwd`, `terminal_title_stripped`. |
| `agent.get` | `target` | Same shape for one agent. Target = pane id or live agent name. |
| `agent.read` | `target, source, lines, format, strip_ansi` | `read.text`. Sources: `visible`, `recent`, `recent_unwrapped`, `detection`. |
| `agent.explain` | `target` | Which detection rule produced the state, with evidence. Great for diagnostics. |
| `agent.prompt` | `target, text, wait?{until[],timeout_ms}` | Submits text + Enter honouring bracketed paste. Returns `agent_blocked` before sending if the agent is at a prompt. With `wait`, `agent_prompt_stalled` if no `working`/`blocked` appears within 5 s. |
| `agent.wait` | `target, until[], timeout_ms?` | Server-owned, event-driven; pins the pane occupant. Tracks state, not turns. |
| `events.subscribe` | `subscriptions[]` | `pane.agent_status_changed` requires `pane_id` (optional `agent_status` filter). `pane.exited`, `pane.closed`, `pane.agent_detected` take no filter. |

## Agent states

`idle`, `working`, `blocked`, `done`, `unknown`. `idle` and `done` both mean ready for input; `done` additionally means a completion has not been "seen" yet. `blocked` = Herdr recognised an approval/question UI. `unknown` = agent present but unclassifiable; never treat it as finished.

Detection rules live in `~/.local/state/herdr/agent-detection/remote/<agent>.toml` and are refreshed by Herdr itself (Claude rules dated 2026-09-11 already cover the 2.1.27x footer that broke AKK).

## Not used yet

`pane.send_input` / `agent.send_keys` (answering menus), `agent.start`, `pane.split`, `workspace.create`, `pane.report_agent` (external lifecycle reporting), `pane.output_matched` subscriptions.

## Remote machines

The socket API above has no machine routing: everything on this page is
answered by whichever Herdr process is on the other end of the socket, local
or remote — there is no `machine` parameter to `agent.list`, `agent.get` or
`events.subscribe`. `herdr --machine <label-or-id> …` is Herdr's own remote
CLI; it forwards a command over SSH to the named machine and prints the
result, but it does not carry these methods verbatim — no `events.subscribe`,
only a blocking `agent wait`, and 6–12 s per call.

So for a remote machine this plugin does not shell out to `herdr --machine`
at all: it opens `ssh <target> socat - UNIX-CONNECT:<sock>` to the remote
Herdr socket and speaks the same protocol described above directly over that
connection, reusing every method on this page including `events.subscribe`.
Details and measured numbers: [ADR 0004](adr/0004-remote-machines-over-ssh-stdio.md) and `src/herdr/ssh-stdio.ts`.
