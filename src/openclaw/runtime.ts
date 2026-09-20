import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../herdr/client.js";
import type { AgentInfo } from "../herdr/types.js";
import { compactPaneText } from "../core/compact.js";
import { formatAgentList, formatSendAccepted, formatStatus, preview } from "../core/format.js";
import { HELP_TEXT, parseHerdrCommand, type HerdrCommand } from "../core/parse.js";
import { resolveTarget } from "../core/targets.js";
import { WatchStore, type WatchRecord } from "../core/watch-store.js";
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
    const store = new WatchStore(stateDir, this.#logger);
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

  /**
   * Sends one prompt. The order is deliberate (finding 1): the watch and its
   * confirmed subscription exist *before* `agent.prompt`, so an agent that
   * answers in a second cannot finish inside a window where nobody listens.
   *
   * The reply distinguishes three outcomes, because telling the operator
   * "nothing was sent" about a prompt that did land is the worst failure here:
   *  - not sent      — target refused, agent blocked, or Herdr refused the call.
   *  - sent          — with or without a working watch.
   *  - uncertain     — the transport died mid-prompt; it may have been delivered.
   */
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

    const watcher = this.#watcher;
    const sessionKey = caller.sessionKey;
    let record: WatchRecord | undefined;
    let trackingFailed = false;
    if (watch && sessionKey && watcher) {
      try {
        record = await watcher.watch({
          // The observed state, never an invented "working": what the agent is
          // doing is Herdr's to say, and `seqAtStart` is captured from it.
          agent,
          sessionKey,
          ...(caller.agentId ? { agentId: caller.agentId } : {}),
          promptPreview: preview(text),
          timeoutMinutes: this.config.watchTimeoutMinutes,
        });
      } catch (error) {
        trackingFailed = true;
        this.#logger.error?.(`herdr: could not start the watch for ${agent.pane_id}: ${describeError(error)}`);
      }
    }

    try {
      await this.client.prompt(agent.pane_id, text);
    } catch (error) {
      if (error instanceof HerdrTransportError) {
        // We do not know whether Herdr got it. Keep the watch: if the prompt
        // did land, the subscription still reports the completion.
        return [
          `I could not confirm the send to **${agent.pane_id}**: ${error.message}.`,
          record
            ? "The prompt may have been delivered; I am still watching, so check /herdr status before resending."
            : "The prompt may have been delivered; check /herdr status before resending.",
          `> ${preview(text)}`,
        ].join("\n");
      }
      if (record) await watcher?.cancel(record.id);
      return `Nothing was sent to ${agent.pane_id}. ${describeFailure(error)}`;
    }

    if (record && watcher) {
      // The prompt is in. Ask Herdr once: a fast agent may already be finished
      // and the pane may even have changed hands. `reconcile` never throws.
      await watcher.reconcile(record.id, "post-prompt");
    }
    return formatSendAccepted(agent, text, record ? "watching" : trackingFailed ? "tracking_failed" : "off");
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

  /**
   * Stops watching. Policy (finding 10): watches are keyed by (pane, session),
   * so several chats may watch the same pane and `unwatch` only removes the
   * caller's own watch — one chat can never silence another. Without a session
   * (a surface that cannot be notified anyway) it clears the pane entirely.
   */
  async unwatch(selector: string, caller: Caller): Promise<string> {
    const watcher = this.#watcher;
    if (!watcher) return "Watcher is not running.";
    const agents = await this.client.listAgents().catch(() => [] as AgentInfo[]);
    const target = resolveTarget(agents, selector);
    const paneId = target.ok ? target.agent.pane_id : selector;
    if (!caller.sessionKey) {
      const removed = await watcher.unwatch(paneId);
      return removed > 0
        ? `Stopped watching ${paneId} (${removed} watch${removed === 1 ? "" : "es"}).`
        : `${paneId} was not being watched.`;
    }
    if ((await watcher.unwatch(paneId, caller.sessionKey)) > 0) return `Stopped watching ${paneId}.`;
    const others = this.#store?.listByPane(paneId).length ?? 0;
    return others > 0
      ? `${paneId} is watched by another chat, not by this one.`
      : `${paneId} was not being watched.`;
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
        return this.unwatch(command.target, caller);
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

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
