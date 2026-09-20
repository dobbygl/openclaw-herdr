import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../herdr/client.js";
import type { AgentInfo } from "../herdr/types.js";
import { compactPaneText } from "../core/compact.js";
import { formatAgentList, formatSendAccepted, formatStatus, preview } from "../core/format.js";
import { HELP_TEXT, parseHerdrCommand, type HerdrCommand } from "../core/parse.js";
import { resolveTarget } from "../core/targets.js";
import { WatchStore } from "../core/watch-store.js";
import { HerdrWatcher, type Notifier } from "../core/watcher.js";
import type { HerdrPluginConfig } from "./config.js";
import type { HostLogger } from "./host-api.js";

export interface Caller {
  sessionKey?: string;
  agentId?: string;
}

/**
 * One object that both the slash command and the agent tools call into.
 * It owns the Herdr client, the durable watch list and the event watcher.
 */
export class HerdrRuntime {
  readonly client: HerdrClient;
  #store: WatchStore | undefined;
  #watcher: HerdrWatcher | undefined;
  #logger: HostLogger;

  constructor(
    readonly config: HerdrPluginConfig,
    private readonly notifier: Notifier,
    logger: HostLogger,
    client?: HerdrClient,
  ) {
    this.#logger = logger;
    this.client =
      client ??
      new HerdrClient({
        ...(config.socketPath ? { socketPath: config.socketPath } : {}),
        requestTimeoutMs: config.requestTimeoutMs,
      });
  }

  async start(stateDir: string, logger?: HostLogger): Promise<void> {
    if (logger) this.#logger = logger;
    const store = new WatchStore(stateDir);
    await store.load();
    this.#store = store;
    this.#watcher = new HerdrWatcher(this.client, store, this.notifier, this.#logger, {
      readLines: this.config.readLines,
    });
    await this.#watcher.start();
    this.#logger.info?.(`herdr: watching ${store.list().length} pane(s); socket ${this.client.socketPath}`);
  }

  async stop(): Promise<void> {
    await this.#watcher?.stop();
  }

  /** Entry point for `/herdr ...`. Always returns chat-ready text. */
  async handleCommand(rawArgs: string | undefined, caller: Caller): Promise<string> {
    const command = parseHerdrCommand(rawArgs);
    try {
      return await this.#run(command, caller);
    } catch (error) {
      return describeFailure(error);
    }
  }

  async list(): Promise<string> {
    const agents = await this.client.listAgents();
    return formatAgentList(agents, this.#store?.list() ?? []);
  }

  async status(selector: string | undefined): Promise<string> {
    const agents = await this.client.listAgents();
    if (!selector) {
      const live = agents.filter((agent) => agent.agent !== null);
      if (live.length !== 1) return formatAgentList(agents, this.#store?.list() ?? []);
      selector = (live[0] as AgentInfo).pane_id;
    }
    const target = resolveTarget(agents, selector);
    if (!target.ok) return target.message;
    const tail = await this.#safeRead(target.agent.pane_id, 12);
    return formatStatus(target.agent, tail, this.#store?.byPane(target.agent.pane_id));
  }

  async read(selector: string, lines: number | undefined): Promise<string> {
    const agents = await this.client.listAgents();
    const target = resolveTarget(agents, selector);
    if (!target.ok) return target.message;
    const read = await this.client.readAgent(target.agent.pane_id, {
      source: "recent",
      lines: lines ?? this.config.readLines,
    });
    const compact = compactPaneText(read.text, { maxLines: lines ?? this.config.readLines });
    return compact ? "```\n" + compact + "\n```" : `${target.agent.pane_id} shows nothing yet.`;
  }

  async send(selector: string | undefined, text: string, caller: Caller, watch = true): Promise<string> {
    const agents = await this.client.listAgents();
    const target = resolveTarget(agents, selector);
    if (!target.ok) return target.message;
    const agent = target.agent;
    if (agent.agent_status === "blocked") {
      const tail = await this.#safeRead(agent.pane_id, 20);
      return [
        `${agent.pane_id} is waiting for input, so I did not send anything.`,
        "Read the prompt below and answer it in the terminal, or tell me what to answer.",
        tail ? "```\n" + compactPaneText(tail, { maxLines: 20 }) + "\n```" : "",
      ].join("\n");
    }
    await this.client.prompt(agent.pane_id, text);
    let watching = false;
    if (watch && caller.sessionKey && this.#watcher) {
      // Refresh the agent so the watch starts from the post-send sequence.
      const fresh = await this.client.getAgent(agent.pane_id).catch(() => agent);
      await this.#watcher.watch({
        agent: { ...fresh, agent_status: "working" },
        sessionKey: caller.sessionKey,
        ...(caller.agentId ? { agentId: caller.agentId } : {}),
        promptPreview: preview(text),
        timeoutMinutes: this.config.watchTimeoutMinutes,
      });
      watching = true;
    }
    return formatSendAccepted(agent, text, watching);
  }

  async watch(selector: string, caller: Caller): Promise<string> {
    if (!caller.sessionKey || !this.#watcher) return "Watching needs an OpenClaw session to report back to.";
    const agents = await this.client.listAgents();
    const target = resolveTarget(agents, selector);
    if (!target.ok) return target.message;
    await this.#watcher.watch({
      agent: target.agent,
      sessionKey: caller.sessionKey,
      ...(caller.agentId ? { agentId: caller.agentId } : {}),
      promptPreview: target.agent.terminal_title_stripped ?? "(current task)",
      timeoutMinutes: this.config.watchTimeoutMinutes,
    });
    return `Watching ${target.agent.pane_id} (${target.agent.agent_status}). I will tell you when it finishes or blocks.`;
  }

  async unwatch(selector: string): Promise<string> {
    if (!this.#watcher) return "Watcher is not running.";
    const agents = await this.client.listAgents().catch(() => [] as AgentInfo[]);
    const target = resolveTarget(agents, selector);
    const paneId = target.ok ? target.agent.pane_id : selector;
    return (await this.#watcher.unwatch(paneId)) ? `Stopped watching ${paneId}.` : `${paneId} was not being watched.`;
  }

  async #run(command: HerdrCommand, caller: Caller): Promise<string> {
    switch (command.kind) {
      case "help":
        return HELP_TEXT;
      case "list":
        return this.list();
      case "status":
        return this.status(command.target);
      case "read":
        return this.read(command.target, command.lines);
      case "watch":
        return this.watch(command.target, caller);
      case "unwatch":
        return this.unwatch(command.target);
      case "send":
        return this.send(command.target, command.text, caller);
    }
  }

  async #safeRead(paneId: string, lines: number): Promise<string | undefined> {
    try {
      return (await this.client.readAgent(paneId, { source: "recent", lines })).text;
    } catch {
      return undefined;
    }
  }
}

export function describeFailure(error: unknown): string {
  if (error instanceof HerdrRequestError) {
    if (error.code === "agent_blocked") return "The agent is waiting at a prompt; answer it first (see /herdr read).";
    return `Herdr refused: ${error.message} (${error.code}).`;
  }
  if (error instanceof HerdrTransportError) {
    return `Cannot reach Herdr: ${error.message}. Is the Herdr server running?`;
  }
  return `Herdr plugin error: ${(error as Error).message ?? String(error)}`;
}
