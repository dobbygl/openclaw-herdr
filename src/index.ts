import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerHerdrCommand } from "./openclaw/commands.js";
import { readPluginConfig } from "./openclaw/config.js";
import type { HostApi } from "./openclaw/host-api.js";
import { OpenClawNotifier } from "./openclaw/notifier.js";
import { HerdrRuntime } from "./openclaw/runtime.js";
import { registerHerdrTools } from "./openclaw/tools.js";

export function registerHerdrPlugin(api: HostApi): HerdrRuntime {
  const config = readPluginConfig(api.pluginConfig);
  const runtime = new HerdrRuntime(config, new OpenClawNotifier(api), api.logger);
  api.registerService({
    id: "herdr-watcher",
    start: (ctx) => runtime.start(ctx.stateDir, ctx.logger),
    stop: () => runtime.stop(),
  });
  registerHerdrCommand(api, runtime);
  registerHerdrTools(api, runtime);
  return runtime;
}

export default definePluginEntry({
  id: "herdr",
  name: "Herdr",
  description:
    "Drive Codex, Claude Code and other coding agents running in Herdr panes from OpenClaw: send prompts, read output, get woken when they finish or block.",
  register(api) {
    registerHerdrPlugin(api as unknown as HostApi);
  },
});
