# ADR 0002: TypeScript, in-process OpenClaw plugin

Date: 2026-09-20 · Status: accepted

## Context

Candidates: TypeScript plugin inside the OpenClaw Gateway; a Rust or Go daemon
bridged to OpenClaw; a Bun service like Collie.

## Decision

TypeScript on Node 24.16+, registered through `openclaw/plugin-sdk` and running
inside the Gateway process.

## Rationale

- OpenClaw's plugin SDK is TypeScript and in-process; commands, tools, services
  and next-turn injections are only available there.
- Herdr's API is JSON lines over a Unix socket: a few dozen lines with `node:net`.
- A separate daemon would add a second runtime, an IPC contract and a supervisor
  for no functional gain.
- Only runtime dependency is `typebox` (tool parameter schemas), which OpenClaw
  itself uses.
