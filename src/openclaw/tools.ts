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

async function guarded(run: () => Promise<string>): Promise<HostToolResult> {
  try {
    return text(await run());
  } catch (error) {
    return text(describeFailure(error));
  }
}

const TargetParam = Type.String({
  description: "Herdr pane id (w6:p1), agent name, or agent kind when unique (claude, codex).",
});

export function registerHerdrTools(api: HostApi, runtime: HerdrRuntime): void {
  const tools: Array<(ctx: HostToolContext) => HostTool> = [
    () => ({
      name: "herdr_list",
      label: "Herdr: list agents",
      description: "List the coding agents Herdr currently sees, with pane id, kind, state and working directory.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () => guarded(() => runtime.list()),
    }),
    (ctx) => ({
      name: "herdr_send",
      label: "Herdr: send prompt",
      description:
        "Send a prompt to one coding agent running in Herdr and watch it. Returns immediately; a '[Herdr watch event]' arrives when the agent finishes or needs input. Refuses if the agent is blocked at a prompt.",
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
        return guarded(() => runtime.send(p.target, p.text, caller(ctx), p.watch ?? true));
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
        return guarded(() => runtime.read(p.target, p.lines));
      },
    }),
    (ctx) => ({
      name: "herdr_watch",
      label: "Herdr: watch agent",
      description: "Watch an agent that is already working and get a '[Herdr watch event]' when it finishes or blocks.",
      parameters: Type.Object({ target: TargetParam }, { additionalProperties: false }),
      execute: (_id, params) => guarded(() => runtime.watch((params as { target: string }).target, caller(ctx))),
    }),
    () => ({
      name: "herdr_status",
      label: "Herdr: status",
      description: "Current state of one agent (or all when target is omitted) plus the tail of its output.",
      parameters: Type.Object({ target: Type.Optional(TargetParam) }, { additionalProperties: false }),
      execute: (_id, params) => guarded(() => runtime.status((params as { target?: string }).target)),
    }),
  ];
  for (const factory of tools) {
    api.registerTool(factory, { optional: true });
  }
}
