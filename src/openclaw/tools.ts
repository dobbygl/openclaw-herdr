import { Type } from "typebox";
import type { HostApi, HostTool, HostToolContext, HostToolResult } from "./host-api.js";
import { describeFailure, type HerdrRuntime } from "./runtime.js";

function text(value: string, details?: unknown): HostToolResult {
  return { content: [{ type: "text", text: value }], details };
}

function caller(ctx: HostToolContext) {
  return {
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
  };
}

async function guarded(runtime: HerdrRuntime, run: () => Promise<string>): Promise<HostToolResult> {
  try {
    return text(await run());
  } catch (error) {
    return text(describeFailure(runtime.messages, error));
  }
}

const TargetParam = Type.String({
  description:
    "Herdr pane id (w6:p1), agent name, tab label (sample#reviewer), or agent kind when unique (claude, codex). Add @machine for a saved Herdr machine: w6:p1@buildbox. No suffix means this host.",
});

export function registerHerdrTools(api: HostApi, runtime: HerdrRuntime): void {
  const tools: Array<(ctx: HostToolContext) => HostTool> = [
    () => ({
      name: "herdr_list",
      label: "Herdr: list agents",
      description:
        "List the coding agents Herdr currently sees, with name (Herdr agent name or operator tab label, when set), pane id, kind, state and working directory. Local agents first, then one group per saved Herdr machine (refs like w1:p1@buildbox); a machine that cannot be reached is shown as down.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () => guarded(runtime, () => runtime.list()),
    }),
    (ctx) => ({
      name: "herdr_send",
      label: "Herdr: send prompt",
      description:
        "Send a prompt to one coding agent running in Herdr and watch it. Returns immediately; a '[Herdr watch event]' arrives when the agent finishes or needs input. Refuses if the agent is blocked at a prompt, or if the target machine is not in the plugin's remote.allowSend list.",
      parameters: Type.Object(
        {
          target: Type.Optional(TargetParam),
          text: Type.String({ description: "The prompt to submit, verbatim." }),
          watch: Type.Optional(Type.Boolean({ description: "Notify when done. Default true." })),
        },
        { additionalProperties: false },
      ),
      execute: (_id, params) => {
        const p = params as { target?: string; text: string; watch?: boolean };
        return guarded(runtime, () => runtime.send(p.target, p.text, caller(ctx), p.watch ?? true));
      },
    }),
    () => ({
      name: "herdr_read",
      label: "Herdr: read pane",
      description: "Read the last lines of one agent's terminal output.",
      parameters: Type.Object(
        { target: TargetParam, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })) },
        { additionalProperties: false },
      ),
      execute: (_id, params) => {
        const p = params as { target: string; lines?: number };
        return guarded(runtime, () => runtime.read(p.target, p.lines));
      },
    }),
    (ctx) => ({
      name: "herdr_watch",
      label: "Herdr: watch agent",
      description: "Watch an agent that is already working and get a '[Herdr watch event]' when it finishes or blocks.",
      parameters: Type.Object({ target: TargetParam }, { additionalProperties: false }),
      execute: (_id, params) => guarded(runtime, () => runtime.watch((params as { target: string }).target, caller(ctx))),
    }),
    () => ({
      name: "herdr_start",
      label: "Herdr: start agent",
      description:
        "Open a new Herdr pane (or reuse an empty pane labelled with the name) and start a coding agent in it. The name becomes the target for herdr_send. Remote machines need remote.allowSend.",
      parameters: Type.Object(
        {
          name: Type.String({ description: "Agent name, lowercase [a-z0-9_-], optionally @machine (as in `herdr agent start <name>`)." }),
          kind: Type.Optional(Type.String({ description: "Agent kind (`--kind`): claude (default), codex, gemini, …" })),
          pane: Type.Optional(Type.String({ description: "Existing idle shell pane to use (`--pane w1:p2`). Omit to open a new pane." })),
          cwd: Type.Optional(Type.String({ description: "Working directory when a new pane is opened." })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 3001, maximum: 300000, description: "Startup wait (`--timeout`)." })),
          args: Type.Optional(Type.Array(Type.String(), { description: "Native agent arguments passed after `--`." })),
        },
        { additionalProperties: false },
      ),
      execute: (_id, params) => {
        const p = params as { name: string; kind?: string; pane?: string; cwd?: string; timeoutMs?: number; args?: string[] };
        return guarded(runtime, () =>
          runtime.startAgent({
            name: p.name,
            agentKind: p.kind ?? "claude",
            ...(p.pane ? { paneId: p.pane } : {}),
            ...(p.cwd ? { cwd: p.cwd } : {}),
            ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
            ...(p.args ? { agentArgs: p.args } : {}),
          }),
        );
      },
    }),
    () => ({
      name: "herdr_status",
      label: "Herdr: status",
      description: "Current state of one agent (or all when target is omitted) plus the tail of its output.",
      parameters: Type.Object({ target: Type.Optional(TargetParam) }, { additionalProperties: false }),
      execute: (_id, params) => guarded(runtime, () => runtime.status((params as { target?: string }).target)),
    }),
  ];
  for (const factory of tools) {
    api.registerTool(factory, { optional: true });
  }
}
