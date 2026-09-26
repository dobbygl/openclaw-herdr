# ADR 0005: Reply language is an explicit plugin setting

Date: 2026-09-26 · Status: accepted

## Context

The plugin's chat replies (`/herdr …`, the `herdr_*` tool results, and watch
notifications) were hard-coded in English, while operators may use another
language. `/herdr` replies go straight to the chat without passing through
the assistant, so nothing translates them on the way. The question was
whether OpenClaw can tell the plugin which language to use.

## What the host provides (OpenClaw 2026.9.5, installed SDK)

Checked in the SDK type declarations and the bundled docs:

- `PluginCommandContext` (slash commands) carries sender, channel, account,
  session and thread identifiers, the command text and the OpenClaw config.
  It has **no** locale or language field.
- `OpenClawPluginToolContext` (tools) carries agent, session, workspace,
  delivery and sender metadata. It has **no** locale or language field.
- Background work (watch notifications, delivered through a heartbeat turn,
  see ADR 0003) has no request context at all.

Sources that exist but do not describe the chat operator, and were rejected:

- `ui.prefs.locale` in the OpenClaw config, and the Control UI's
  language picker, which is stored in the browser. These are preferences of
  the web Control UI, not of the person on a chat channel.
- The `locale` a gateway client sends in its connect handshake. It describes
  that client connection (Control UI, CLI, a device), not the conversation
  a plugin command or tool call belongs to.
- `language` settings for speech and media transcription. These are audio
  model hints.
- Inferring the language from sender ids, channel names, terminal output,
  conversation history or an LLM call. That is guessing, it can read private
  history, and it would cost a model call on every `list` or `status`.

## Decision

- The plugin has a `language` setting: `en` (default) or `es`. The manifest
  enumerates exactly these values, and the runtime parser accepts exactly
  the same ones (a test keeps them in sync). OpenClaw validates plugin
  config against the manifest schema before the plugin loads. Per its
  docs, Gateway startup then skips a plugin with invalid config, and
  `openclaw doctor` quarantines it. So another value (another language, a
  region tag such as `es-ES`, a typo) is refused by the host, not by the
  plugin. The runtime parser is defense in depth: if an unsupported value
  reaches it anyway, it replies in English and logs a warning. There is no
  `auto` mode, because there is nothing reliable to detect from.
- The setting is plugin-wide. Per-conversation overrides were considered and
  deferred. Without a trusted per-conversation preference from the host, one
  would need its own command and its own persisted state keyed by session,
  and that deserves a separate decision.
- The text lives in a typed catalog (`src/core/i18n.ts`). Both languages have
  the same keys and argument lists, which the typechecker and a test enforce.
  Every function that builds chat text takes the catalog as a required
  argument, so a forgotten call site does not compile rather than silently
  answering in English. No translation needs a model call.
- A watch stores the language of the reply that created it. Its notification
  uses that language even if the setting changed and the Gateway restarted
  since. Notifications that are pending delivery are persisted already
  formatted, so a retry does not change language either. A record written
  before this setting existed, or one carrying an unknown value, is read as
  English. It is not quarantined. Each watch is keyed by its own session, so
  one chat's language never affects another.

## What stays unchanged

- Identifiers and operator data are always interpolated verbatim: pane ids,
  terminal ids, agent names, tab labels, machine labels, paths, prompt
  previews, and the agent's own output. Terminal output is never translated.
- Command syntax is the same in every language, placeholders included
  (`/herdr read <target> [lines 1-400]`). A test checks that every command
  line in the help is identical in both languages, and that both parse the
  same way.
- Agent states (`idle`, `working`, `blocked`, `done`, `unknown`) are Herdr's
  vocabulary and are shown as Herdr reports them.
- Herdr's own error messages and codes are quoted verbatim. Transport and
  reachability reasons (`ssh authentication failed`, `… is not reachable`)
  stay English, because they come from lower layers and logs.
- Model-facing text stays English: tool descriptions, agent guidance, and
  the relay header of a watch event (the assistant is told to relay the
  already-localized notification as-is). Logs stay English.

## Consequences

- An operator who writes in Spanish sets `"language": "es"` once and gets
  Spanish replies and notifications, with no extra model cost.
- A new language means one more catalog. The typechecker lists anything
  missing.
- If OpenClaw later exposes a trusted per-conversation language to plugins,
  it can take precedence over this setting, with the setting as the
  fallback. Until then, this setting is the only source.
