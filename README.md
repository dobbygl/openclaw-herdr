<div align="center">
  <img src="assets/logo.png" width="160" alt="openclaw-herdr logo: a goat kid and a lobster fist-bumping">

  # openclaw-herdr
  *Drive the coding agents in your Herdr panes from OpenClaw chat*

  [![CI](https://img.shields.io/github/actions/workflow/status/dobbygl/openclaw-herdr/ci.yml?style=flat-square)](https://github.com/dobbygl/openclaw-herdr/actions)
  [![Node.js](https://img.shields.io/badge/Node.js->=22-3c873a?style=flat-square)](https://nodejs.org)
  [![OpenClaw plugin](https://img.shields.io/badge/OpenClaw-plugin-orange?style=flat-square)](https://docs.openclaw.ai/cli/plugins)
  [![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

  [Features](#features) • [Installation](#installation) • [Usage](#usage) • [How it works](#how-it-works) • [Configuration](#configuration)
</div>

`openclaw-herdr` is an [OpenClaw](https://openclaw.ai) plugin that lets you talk to Claude Code, Codex, or any other coding agent already running inside [Herdr](https://herdr.dev) panes. Send a prompt from Telegram or the OpenClaw web chat, keep the terminal visible for yourself, and get pinged when the agent finishes or stops to ask a question.

It replaces screen scraping with Herdr's own agent lifecycle API, so it does not care which version of Herdr, Claude Code or Codex you run today.

> [!NOTE]
> Status: early prototype (M0). The command surface and tests exist; the first live loop against a real Gateway is the next milestone. See [docs/PLAN.md](docs/PLAN.md).

## Features

- **Send from chat** — `/herdr w6:p1: run the tests` submits a prompt to one pane, respecting bracketed paste.
- **Get woken up** — one event subscription per watched pane; you receive a message when the agent goes idle, finishes, blocks on a question, or exits. No polling.
- **Never guess** — targets must resolve to exactly one live agent. Ambiguity and Herdr's `unknown` state are reported, not papered over.
- **Blocked-aware** — if the agent is waiting at an approval or question, the plugin shows you the prompt instead of typing over it.
- **Agent tools too** — `herdr_list`, `herdr_send`, `herdr_read`, `herdr_watch` and `herdr_status` let the OpenClaw agent orchestrate panes on its own.
- **Survives restarts** — watches live in a small JSON file and are re-subscribed when the Gateway comes back.
- **Zero runtime dependencies** beyond `typebox`; talks to Herdr over its local Unix socket only.

## Installation

Requirements: OpenClaw `2026.9.2+`, Herdr `0.9.x` running locally (`herdr status server`), Node.js `22+`, and a coding agent started inside a Herdr pane.

```bash
git clone https://github.com/dobbygl/openclaw-herdr.git
cd openclaw-herdr
npm install
npm run build
openclaw plugins install "$PWD"
openclaw gateway restart
```

Check that the plugin can see Herdr before using it from chat:

```bash
npm run smoke
```

## Usage

From any OpenClaw chat surface:

```text
/herdr list                      agents Herdr currently sees
/herdr w6:p1: fix the failing test and explain the cause
/herdr fix the failing test      same, when exactly one agent is running
/herdr status w6:p1              state plus the last lines of output
/herdr read w6:p1 60             more output
/herdr watch w6:p1               wake me when the current task settles
/herdr unwatch w6:p1
```

A target is a Herdr pane id (`w6:p1`), a Herdr agent name (`reviewer`), or the agent kind (`claude`, `codex`) when only one of that kind is running.

When a watched agent settles, the originating chat gets a short message like:

```text
Herdr: w6:p1 (claude) finished.
> fix the failing test and explain the cause
```
followed by the tail of the pane. A `needs your input` variant appears when Herdr detects an approval or question UI.

> [!TIP]
> Agents started with `claude` or `codex --yolo` in bypass mode will run whatever you send. Keep the `/herdr` command restricted to authorized senders (the default) and prefer normal permission modes for anything that touches production.

## How it works

```text
Telegram / WebChat ──► OpenClaw Gateway ──(in-process)──► openclaw-herdr ──JSON lines──► herdr.sock ──► Herdr ──► Claude Code / Codex pane
```

1. `/herdr …` is parsed into a small command; the target is resolved against a fresh `agent.list`.
2. Prompts go through `agent.prompt`. Herdr refuses with `agent_blocked` if the agent is at a prompt, before any input is sent.
3. A watch record is stored and a `pane.agent_status_changed` subscription is opened for that pane.
4. On `working → idle | done | blocked`, the plugin reads the last lines, queues a next-turn injection for the originating session and asks the Gateway for a heartbeat so the message reaches you promptly.

Herdr classifies agents with detection rules it updates by itself; this plugin never parses terminal text to decide anything. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/HERDR_API.md](docs/HERDR_API.md).

## Configuration

Optional keys under `plugins.entries.herdr.config` in `openclaw.json`:

| Key | Default | Purpose |
| --- | --- | --- |
| `socketPath` | `$HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock` | Herdr server socket |
| `requestTimeoutMs` | `5000` | Timeout per Herdr request |
| `watchTimeoutMinutes` | `720` | Ceiling for a watch that never settles |
| `readLines` | `40` | Lines of pane output included in notifications and `/herdr read` |

## Development

```bash
npm install
npm run typecheck
npm test
npm run smoke      # read-only check against your local Herdr
npm run check      # typecheck + tests + build
```

Design decisions are recorded in [docs/adr](docs/adr). The roadmap and the incident that motivated this project are in [docs/PLAN.md](docs/PLAN.md).
