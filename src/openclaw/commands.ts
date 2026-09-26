import type { HostApi } from "./host-api.js";
import type { HerdrRuntime } from "./runtime.js";

export const AGENT_GUIDANCE = [
  "Herdr plugin: use the herdr_* tools to list, prompt, read and watch coding agents (Claude Code, Codex, ...) running in Herdr panes. Never poll: after herdr_send or herdr_watch, stop and wait for the '[Herdr watch event]' context that arrives when the agent finishes or blocks.",
  "Targets are Herdr pane ids like w6:p1, agent names, tab labels like sample#reviewer, or an agent kind when only one is running. Always take them from a fresh herdr_list.",
  "A target may name a saved Herdr machine with @label (w6:p1@buildbox); without a suffix it is this host. Remote panes can be listed and read, but prompts only reach the machines the operator allowed.",
];

export function registerHerdrCommand(api: HostApi, runtime: HerdrRuntime): void {
  api.registerCommand({
    name: "herdr",
    description: "Drive coding agents running in Herdr: /herdr list, /herdr <pane>: <prompt>, /herdr status, /herdr read, /herdr watch",
    acceptsArgs: true,
    requireAuth: true,
    agentPromptGuidance: AGENT_GUIDANCE,
    handler: async (ctx) => {
      const text = await runtime.handleCommand(ctx.args, {
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });
      return { text };
    },
  });
}
