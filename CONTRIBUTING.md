# Contributing

Thanks for helping. This project is small on purpose; please keep it that way.

## Ground rules

- Agent state comes from Herdr (`agent.get`, `agent.explain`, events). Do not add code that parses terminal screens to decide what an agent is doing. See `docs/adr/0001`.
- Do not pin exact Herdr, Claude Code or Codex versions. Ignore unknown fields, treat unsupported methods as errors.
- Chat output is read on phones. Keep it short, one idea per line.

## Workflow

```bash
npm install
npm run typecheck
npm test
npm run smoke      # read-only against your local Herdr
```

Open a pull request against `main`. CI runs typecheck, tests and build.

## Commits

Conventional Commits, in English, subject line only: `feat: …`, `fix: …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`.

## Reporting bugs

Include `herdr status server`, `openclaw --version`, the agent and its version, and the output of `herdr agent explain <pane>` when the plugin disagrees with what you see in the pane.
