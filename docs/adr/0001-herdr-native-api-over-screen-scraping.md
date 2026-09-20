# ADR 0001: Use Herdr's native agent API instead of parsing terminal screens

Date: 2026-09-20 · Status: accepted

## Context

AKK controlled agents by capturing pane text, classifying the composer with
regular expressions, reading agent transcripts, and pinning exact versions of
Herdr, Claude Code and Codex. Three of those assumptions broke on one day
(see docs/PLAN.md). Herdr 0.9.1 exposes agent lifecycle (`idle`, `working`,
`blocked`, `done`, `unknown`), prompt submission, waits and event streams over
a documented JSON socket API, and maintains its own OTA-updated detection rules.

## Decision

The plugin never reads or interprets terminal screens to decide anything. It
asks Herdr. If Herdr says `unknown`, the plugin says so. If a capability is
missing, we propose it upstream rather than scrape around it.

## Consequences

- Far less code (≈1.5k lines vs. 150k) and no per-version profiles.
- Correctness is bounded by Herdr's detection quality; diagnostics use `agent.explain`.
- Turn attribution is by state transitions and sequence numbers, not by transcript hashes.
