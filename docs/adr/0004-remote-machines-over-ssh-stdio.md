# ADR 0004: Remote Herdr machines over SSH stdio

Date: 2026-09-20 · Status: accepted

## Context

M2.5 needed the plugin to monitor, and when explicitly allowed drive, agents
in a Herdr running on another machine (first case: one saved machine, a
different remote user, already linked with `herdr machine add`).

Read-only probes from this host on 2026-09-20 established the facts the
decision rests on:

- Herdr's local socket API has no machine routing, and the local snapshot
  does not include saved machines: `/herdr list` cannot see them through the
  local socket at all.
- Herdr's own remote automation, `herdr --machine <label-or-id> …`, works
  from this host but costs 6–12 s per call (SSH plus remote bridge
  discovery) and exposes no `events.subscribe` — only a blocking
  `agent wait`. Watching a remote agent needs the streaming subscription.
- Raw SSH to the same host: 2.0 s cold, 1.3 s with `ControlMaster`. Speaking
  the socket protocol directly over SSH stdio — `ssh <target> socat -
  UNIX-CONNECT:<sock>`, or a python3 one-liner where `socat` is missing —
  answers `ping` in ~0.6 s with a warm `ControlMaster` and is the exact
  newline-delimited JSON the plugin already implements, including
  `events.subscribe`.
- The remote socket is mode `0600` and owned by the remote user, so the
  saved machine's SSH target must use that user; `herdr machine add` already
  requires the same.

## Decision

- Remote transport is **SSH stdio to the remote socket**. `HerdrClient` gets
  a pluggable connection factory (`src/herdr/connection.ts`): `local`
  connects to the Unix socket, a remote machine spawns
  `ssh <target> socat - UNIX-CONNECT:<sock>` per request and per
  subscription, reusing the existing `LineDecoder` and framing. The
  transport also carries a python3 bridge for hosts without `socat`, but no
  plugin config key selects it yet, so `socat` on the remote host is the
  effective requirement.
  `ssh` is spawned with an argv array, never a shell string; every
  caller-influenced value that ends up in the *remote* command line (socket
  path, session name, remote binary) is checked against a strict whitelist
  first (`src/herdr/ssh-stdio.ts`).
- SSH options are fixed and private to the plugin, not configurable:
  `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=10`,
  `ServerAliveInterval=15`, `ServerAliveCountMax=4`, `ControlMaster=auto`,
  `ControlPersist=120`. `ControlPath` lives under the plugin state dir, at
  `<stateDir>/ssh/<machineId>.sock`, in a directory created mode `0700`. No
  tunnel service, no local socket file for a remote machine, no TCP.
- Machines are **discovered, not configured**: the registry (`src/core/
  servers.ts`) reads `local` plus every enabled profile from `herdr machine
  list --json` (label, id, SSH target, session), each behind a short-lived
  cache (`src/herdr/machines.ts`). The remote socket path is resolved once
  per machine with `ssh <target> herdr status server` and cached for
  minutes, not seconds — it does not change while the server is up.
  `@server` in a target must match a profile label (unique, case-sensitive)
  or id; watches store the profile id and display the label.
- `herdr --machine` remains the human CLI and is not used as a fallback
  transport by the plugin: the streaming subscription it lacks is required
  for watches, so there is nothing it can usefully substitute for.
- Target grammar is `selector[@server]`: `w1:p1@buildbox`,
  `reviewer@buildbox`, `claude@buildbox`. No suffix means `local`.
- Per-machine `allowSend` (config key `remote.allowSend`, default empty):
  remote reads are on whenever `remote.enabled` is true, remote prompts and
  key presses are opt-in per machine label or id.
- Remote watches behave exactly like local ones — subscription plus
  `agent.get` reconciliation, `sawWorking`, `terminal_id`,
  `state_change_seq` fencing. An SSH drop is just a closed subscription: the
  watcher reconnects with backoff and reconciles, the same path a local
  Herdr restart already takes.

## Consequences

- The SSH user for a saved machine must own, or at least be able to read,
  that machine's Herdr socket (mode `0600`); this is also what `herdr
  machine add` itself requires, so nothing new is asked of the operator.
- `BatchMode=yes` and `StrictHostKeyChecking=yes` are non-negotiable: an
  unattended plugin must never wait on a password prompt or silently trust a
  new host key. In practice this means an SSH key for that user must already
  be loaded (`ssh-add`) and the host key must already be trusted — both of
  which the interactive first run of `herdr machine add` takes care of.
- One `ssh` process per request and per subscription. `ControlMaster`
  multiplexing keeps this cheap (≈0.6 s per request on a saved machine once
  warm) but it is still a process per call, not a persistent connection the
  plugin holds open — a flapping network means a flapping process count.
- No tunnel service and no daemon to supervise: the tradeoff is one `ssh`
  child's worth of latency and failure modes per call, in exchange for zero
  new long-running processes.
- The remote host needs `socat` installed; the plugin does not install
  anything there.
- Failure classification (`classifySshFailure` in `src/herdr/ssh-stdio.ts`)
  turns ssh/socat stderr into one short, operator-readable reason — used
  both for `/herdr list`'s `down` line and for deciding when a machine
  should be marked unhealthy and re-probed.
