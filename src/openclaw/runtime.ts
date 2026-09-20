import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../herdr/client.js";
import type { AgentInfo } from "../herdr/types.js";
import { compactPaneText } from "../core/compact.js";
import {
  formatAgentList,
  formatSendAccepted,
  formatServerList,
  formatStatus,
  preview,
  type ServerGroup,
} from "../core/format.js";
import {
  formatTargetRef,
  HELP_TEXT,
  parseHerdrCommand,
  parseTargetRef,
  TargetSyntaxError,
  type HerdrCommand,
} from "../core/parse.js";
import { LOCAL_SERVER_ID, ServerRegistry, shortReason, type ServerDescription } from "../core/servers.js";
import { resolveTarget } from "../core/targets.js";
import { WatchStore, type WatchRecord } from "../core/watch-store.js";
import { HerdrWatcher, type Notifier } from "../core/watcher.js";
import type { HerdrPluginConfig } from "./config.js";
import type { HostLogger } from "./host-api.js";

export interface Caller {
  sessionKey?: string;
  agentId?: string;
}

/** A target that was resolved down to one live agent on one server. */
interface LocatedTarget {
  server: ServerDescription;
  client: HerdrClient;
  agent: AgentInfo;
  /** What the operator can copy back: `w1:p1`, or `w1:p1@buildbox`. */
  ref: string;
}

type LocateOutcome = { ok: true; target: LocatedTarget } | { ok: false; message: string };

/**
 * One object that both the slash command and the agent tools call into.
 * It owns the server registry (local plus every Herdr machine), the durable
 * watch list and the event watcher.
 *
 * Every command takes a `selector[@server]` target: the selector is resolved
 * against *that server's* agent list, so `w1:p1` and `w1:p1@buildbox` are two
 * different panes and neither can be confused for the other.
 */
export class HerdrRuntime {
  readonly client: HerdrClient;
  #registry: ServerRegistry | undefined;
  #store: WatchStore | undefined;
  #watcher: HerdrWatcher | undefined;
  #logger: HostLogger;

  constructor(
    readonly config: HerdrPluginConfig,
    private readonly notifier: Notifier,
    logger: HostLogger,
    client?: HerdrClient,
    /** Pre-built registry; the service builds one at `start()` when omitted. */
    registry?: ServerRegistry,
  ) {
    this.#logger = logger;
    this.client =
      client ??
      new HerdrClient({
        ...(config.socketPath ? { socketPath: config.socketPath } : {}),
        requestTimeoutMs: config.requestTimeoutMs,
      });
    this.#registry = registry;
  }

  /**
   * The registry is built here, not in the constructor: it needs `stateDir`
   * for the ssh ControlMaster sockets, which only the service knows.
   */
  async start(stateDir: string, logger?: HostLogger): Promise<void> {
    if (logger) this.#logger = logger;
    const registry =
      this.#registry ??
      new ServerRegistry({
        ...(this.config.socketPath ? { socketPath: this.config.socketPath } : {}),
        requestTimeoutMs: this.config.requestTimeoutMs,
        remoteEnabled: this.config.remote.enabled,
        allowSend: this.config.remote.allowSend,
        ...(this.config.herdrBin ? { herdrBin: this.config.herdrBin } : {}),
        ...(this.config.sshBin ? { sshBin: this.config.sshBin } : {}),
        stateDir,
        localClient: this.client,
        logger: this.#logger,
      });
    this.#registry = registry;
    await registry.prepare();

    const store = new WatchStore(stateDir, this.#logger);
    await store.load();
    this.#store = store;
    this.#watcher = new HerdrWatcher(
      (serverId) => registry.clientFor(serverId),
      store,
      this.notifier,
      this.#logger,
      {
        readLines: this.config.readLines,
        serverLabel: (serverId) => registry.describe(serverId).label,
        onServerError: (serverId, reason) => registry.reportFailure(serverId, reason),
      },
    );
    await this.#watcher.start();
    this.#logger.info?.(
      `herdr: watching ${store.list().length} pane(s); socket ${this.client.socketPath}; remote machines ${registry.remoteEnabled ? "enabled" : "disabled"}`,
    );
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

  /**
   * `/herdr list`: this host first, then one group per machine. Each machine is
   * pinged first (issue 5), so a sleeping box costs one short probe and shows
   * up as `down` with its reason instead of stalling the whole list.
   */
  async list(): Promise<string> {
    const registry = this.#registry;
    const watches = this.#store?.list() ?? [];
    if (!registry) return formatAgentList(await this.client.listAgents(), watches);
    const servers = await registry.servers();
    const groups = await Promise.all(servers.map((server) => this.#groupFor(registry, server)));
    const catalogError = registry.catalogError();
    return formatServerList(
      groups,
      watches,
      catalogError ? `Machine list unavailable: ${catalogError}` : undefined,
    );
  }

  async status(target: string | undefined): Promise<string> {
    const located = await this.#locate(target);
    if (!located.ok) return located.message;
    const { agent, client, server, ref } = located.target;
    const tail = await this.#safeRead(client, agent.pane_id, 12);
    return formatStatus(agent, tail, this.#store?.byPane({ serverId: server.id, paneId: agent.pane_id }), ref);
  }

  async read(target: string, lines: number | undefined): Promise<string> {
    const located = await this.#locate(target);
    if (!located.ok) return located.message;
    const { agent, client, ref } = located.target;
    const read = await client.readAgent(agent.pane_id, {
      source: "recent",
      lines: lines ?? this.config.readLines,
    });
    const compact = compactPaneText(read.text, { maxLines: lines ?? this.config.readLines });
    return compact ? "```\n" + compact + "\n```" : `${ref} shows nothing yet.`;
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
   *
   * A remote pane is read-only unless its machine is listed in
   * `remote.allowSend`: reading someone else's box is cheap, typing into an
   * agent there is not.
   */
  async send(target: string | undefined, text: string, caller: Caller, watch = true): Promise<string> {
    const located = await this.#locate(target);
    if (!located.ok) return located.message;
    const { agent, client, server, ref } = located.target;
    const refusal = this.#refuseSend(server, ref);
    if (refusal) return refusal;
    if (agent.agent_status === "blocked") {
      const tail = await this.#safeRead(client, agent.pane_id, 20);
      return [
        `${ref} is waiting for input, so I did not send anything.`,
        "Read the prompt below and answer it in the terminal (Herdr or Collie); answering from chat is not implemented yet.",
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
          serverId: server.id,
          sessionKey,
          ...(caller.agentId ? { agentId: caller.agentId } : {}),
          promptPreview: preview(text),
          timeoutMinutes: this.config.watchTimeoutMinutes,
        });
      } catch (error) {
        trackingFailed = true;
        this.#logger.error?.(`herdr: could not start the watch for ${ref}: ${describeError(error)}`);
      }
    }

    try {
      await client.prompt(agent.pane_id, text);
    } catch (error) {
      if (error instanceof HerdrTransportError) {
        // We do not know whether Herdr got it. Keep the watch: if the prompt
        // did land, the subscription still reports the completion.
        return [
          `I could not confirm the send to **${ref}**: ${error.message}.`,
          record
            ? "The prompt may have been delivered; I am still watching, so check /herdr status before resending."
            : "The prompt may have been delivered; check /herdr status before resending.",
          `> ${preview(text)}`,
        ].join("\n");
      }
      if (record) await watcher?.cancel(record.id);
      return `Nothing was sent to ${ref}. ${describeFailure(error)}`;
    }

    if (record && watcher) {
      // The prompt is in. Ask Herdr once: a fast agent may already be finished
      // and the pane may even have changed hands. `reconcile` never throws.
      await watcher.reconcile(record.id, "post-prompt");
    }
    return formatSendAccepted(agent, text, record ? "watching" : trackingFailed ? "tracking_failed" : "off", ref);
  }

  async watch(target: string, caller: Caller): Promise<string> {
    if (!caller.sessionKey || !this.#watcher) return "Watching needs an OpenClaw session to report back to.";
    const located = await this.#locate(target);
    if (!located.ok) return located.message;
    const { agent, server, ref } = located.target;
    await this.#watcher.watch({
      agent,
      serverId: server.id,
      sessionKey: caller.sessionKey,
      ...(caller.agentId ? { agentId: caller.agentId } : {}),
      promptPreview: agent.terminal_title_stripped ?? "(current task)",
      timeoutMinutes: this.config.watchTimeoutMinutes,
    });
    return `Watching ${ref} (${agent.agent_status}). I will tell you when it finishes or blocks.`;
  }

  /**
   * Stops watching. Policy (finding 10): watches are keyed by (server, pane,
   * session), so several chats may watch the same pane and `unwatch` only
   * removes the caller's own watch — one chat can never silence another.
   * Without a session (a surface that cannot be notified anyway) it clears the
   * pane entirely. A `@server` suffix scopes it to that machine.
   */
  async unwatch(target: string, caller: Caller): Promise<string> {
    const watcher = this.#watcher;
    if (!watcher) return "Watcher is not running.";
    let parsed: { selector: string; server?: string };
    try {
      parsed = parseTargetRef(target);
    } catch (error) {
      if (error instanceof TargetSyntaxError) return error.message;
      throw error;
    }
    const server = await this.#resolveServer(parsed.server);
    if (!server.ok) return server.message;
    // The pane may be gone (that is often why the operator unwatches), so a
    // failed lookup falls back to the selector as a literal pane id.
    const agents = await this.#listAgentsQuietly(server.server.id);
    const resolved = resolveTarget(agents, parsed.selector);
    const paneId = resolved.ok ? resolved.agent.pane_id : parsed.selector;
    const suffix = server.server.isLocal ? undefined : server.server.label;
    const ref = formatTargetRef(paneId, suffix);
    const paneRef = { serverId: server.server.id, paneId };
    if (!caller.sessionKey) {
      const removed = await watcher.unwatch(paneRef);
      return removed > 0
        ? `Stopped watching ${ref} (${removed} watch${removed === 1 ? "" : "es"}).`
        : `${ref} was not being watched.`;
    }
    if ((await watcher.unwatch(paneRef, caller.sessionKey)) > 0) return `Stopped watching ${ref}.`;
    const others = this.#store?.listByPane(paneRef).length ?? 0;
    return others > 0 ? `${ref} is watched by another chat, not by this one.` : `${ref} was not being watched.`;
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
      case "error":
        return command.message;
    }
  }

  // ---- internals ----

  /**
   * `selector[@server]` → one live agent on one server.
   *
   * Without a target it means "the only agent on this host"; when this host
   * runs several (or none) the answer is the full grouped list, which is what
   * the operator needs in order to name one.
   */
  async #locate(target: string | undefined): Promise<LocateOutcome> {
    let selector: string | undefined;
    let serverName: string | undefined;
    if (target !== undefined) {
      try {
        const parsed = parseTargetRef(target);
        selector = parsed.selector;
        serverName = parsed.server;
      } catch (error) {
        if (error instanceof TargetSyntaxError) return { ok: false, message: error.message };
        throw error;
      }
    }
    const server = await this.#resolveServer(serverName);
    if (!server.ok) return { ok: false, message: server.message };
    let client: HerdrClient;
    try {
      client = await this.#clientFor(server.server.id);
    } catch (error) {
      return { ok: false, message: this.#unreachable(server.server, error) };
    }
    const agents = await client.listAgents();
    if (selector === undefined) {
      const live = agents.filter((agent) => agent.agent !== null);
      if (live.length !== 1) return { ok: false, message: await this.list() };
      selector = (live[0] as AgentInfo).pane_id;
    }
    const resolved = resolveTarget(agents, selector);
    if (!resolved.ok) {
      // Which herd was searched matters: `w1:p1` exists on several machines.
      return {
        ok: false,
        message: server.server.isLocal ? resolved.message : `On ${server.server.label}: ${resolved.message}`,
      };
    }
    const suffix = server.server.isLocal ? undefined : server.server.label;
    return {
      ok: true,
      target: {
        server: server.server,
        client,
        agent: resolved.agent,
        ref: formatTargetRef(resolved.agent.pane_id, suffix),
      },
    };
  }

  async #resolveServer(
    name: string | undefined,
  ): Promise<{ ok: true; server: ServerDescription } | { ok: false; message: string }> {
    const registry = this.#registry;
    if (!registry) {
      if (name === undefined || name === LOCAL_SERVER_ID) {
        return { ok: true, server: { id: LOCAL_SERVER_ID, label: LOCAL_SERVER_ID, isLocal: true } };
      }
      return { ok: false, message: `I know no Herdr server called "${name}". Known: ${LOCAL_SERVER_ID}.` };
    }
    return registry.resolve(name);
  }

  /** Always through the registry, so `local` has exactly one client too. */
  async #clientFor(serverId: string): Promise<HerdrClient> {
    if (!this.#registry) return this.client;
    return this.#registry.client(serverId);
  }

  /** One `/herdr list` group: ping the machine, then ask it for its agents. */
  async #groupFor(registry: ServerRegistry, server: ServerDescription): Promise<ServerGroup> {
    const base = { id: server.id, label: server.label, isLocal: server.isLocal };
    if (!server.isLocal) {
      const health = await registry.ping(server.id);
      if (!health.ok) return { ...base, down: health.reason ?? "no answer" };
    }
    try {
      const client = await this.#clientFor(server.id);
      return { ...base, agents: await client.listAgents() };
    } catch (error) {
      const reason = shortMessage(error);
      if (!server.isLocal) registry.reportFailure(server.id, reason);
      return { ...base, down: reason };
    }
  }

  /** `agent.list` for a server, or an empty herd: used where a failure is not fatal. */
  async #listAgentsQuietly(serverId: string): Promise<AgentInfo[]> {
    try {
      const client = await this.#clientFor(serverId);
      return await client.listAgents();
    } catch {
      return [];
    }
  }

  /** The `remote.allowSend` gate. Shared by every path that types into a pane. */
  #refuseSend(server: ServerDescription, ref: string): string | undefined {
    if (server.isLocal) return undefined;
    if (this.#registry?.allowsSend(server.id) ?? false) return undefined;
    return [
      `I did not send anything to **${ref}**: ${server.label} is read-only.`,
      `Add "${server.label}" to remote.allowSend in the plugin config to allow prompts there.`,
    ].join("\n");
  }

  #unreachable(server: ServerDescription, error: unknown): string {
    if (server.isLocal) return describeFailure(error);
    return `I cannot reach ${server.label}: ${shortMessage(error)}.`;
  }

  async #safeRead(client: HerdrClient, paneId: string, lines: number): Promise<string | undefined> {
    try {
      return (await client.readAgent(paneId, { source: "recent", lines })).text;
    } catch {
      return undefined;
    }
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last, actionable segment of a layered transport message. */
function shortMessage(error: unknown): string {
  return shortReason(describeError(error));
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
