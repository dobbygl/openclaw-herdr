# Agent instructions

- Run `npm test` and `npm run typecheck` before proposing a commit. `npm run smoke` is read-only against the local Herdr and safe to run.
- Never add code that parses terminal screens to infer agent state. Ask Herdr (`agent.get`, `agent.explain`). See docs/adr/0001.
- Do not pin exact Herdr, Claude Code or Codex versions. Ignore unknown fields.
- Keep chat output short and phone-friendly; the operator reads it on Telegram.
- Commits: Conventional Commits in English, subject line only.
