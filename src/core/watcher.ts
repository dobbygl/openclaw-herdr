import type { HerdrClient, Subscription } from "../herdr/client.js";
import type { AgentInfo, AgentStatus, SubscriptionEvent } from "../herdr/types.js";
import { formatNotification } from "./format.js";
import type { WatchRecord, WatchStore } from "./watch-store.js";

export type SettledStatus = Extract<AgentStatus, "idle" | "done" | "blocked"> | "exited" | "timed_out";

export interface Notifier {
  notify(watch: WatchRecord, status: SettledStatus, text: string): Promise<void>;
}

export interface WatcherLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** The subset of HerdrClient the watcher needs; makes tests trivial. */
export type WatcherClient = Pick<HerdrClient, "subscribe" | "readAgent" | "getAgent">;

export interface WatcherOptions {
  readLines?: number;
  reconnectDelayMs?: number;
  sweepIntervalMs?: number;
  now?: () => Date;
}

/**
 * Keeps one Herdr event subscription per watched pane and turns
 * `pane.agent_status_changed` into a single chat notification when the agent
 * reaches idle/done (finished) or blocked (needs input). No polling, no
 * screen parsing: Herdr already classifies the agent for us.
 */
export class HerdrWatcher {
  #subscriptions = new Map<string, Subscription>();
  #sweep: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(
    private readonly client: WatcherClient,
    private readonly store: WatchStore,
    private readonly notifier: Notifier,
    private readonly logger: WatcherLogger = {},
    private readonly options: WatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    this.#stopped = false;
    for (const watch of this.store.list()) this.#subscribe(watch);
    const interval = this.options.sweepIntervalMs ?? 60_000;
    this.#sweep = setInterval(() => void this.#sweepDeadlines(), interval);
    this.#sweep.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#sweep) clearInterval(this.#sweep);
    for (const subscription of this.#subscriptions.values()) subscription.close();
    this.#subscriptions.clear();
  }

  async watch(input: {
    agent: AgentInfo;
    sessionKey: string;
    agentId?: string;
    promptPreview: string;
    timeoutMinutes: number;
  }): Promise<WatchRecord> {
    const now = this.options.now?.() ?? new Date();
    const record = await this.store.add({
      paneId: input.agent.pane_id,
      terminalId: input.agent.terminal_id,
      agentLabel: input.agent.name ?? input.agent.agent ?? "agent",
      sessionKey: input.sessionKey,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      promptPreview: input.promptPreview,
      deadlineAt: new Date(now.getTime() + input.timeoutMinutes * 60_000).toISOString(),
      seqAtStart: input.agent.state_change_seq ?? 0,
      lastStatus: input.agent.agent_status,
    });
    this.#subscribe(record);
    return record;
  }

  async unwatch(paneId: string): Promise<boolean> {
    const record = this.store.byPane(paneId);
    if (!record) return false;
    this.#subscriptions.get(record.id)?.close();
    this.#subscriptions.delete(record.id);
    return this.store.remove(record.id);
  }

  #subscribe(watch: WatchRecord): void {
    this.#subscriptions.get(watch.id)?.close();
    const subscription = this.client.subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: watch.paneId },
        { type: "pane.exited" },
        { type: "pane.closed" },
      ],
      (event) => void this.#onEvent(watch.id, event),
      (error) => this.logger.warn?.(`herdr watch ${watch.paneId}: ${error.message}`),
    );
    this.#subscriptions.set(watch.id, subscription);
    void subscription.closed.then(() => {
      if (this.#stopped || this.#subscriptions.get(watch.id) !== subscription) return;
      const delay = this.options.reconnectDelayMs ?? 2_000;
      setTimeout(() => {
        const current = this.store.list().find((candidate) => candidate.id === watch.id);
        if (current && !this.#stopped) this.#subscribe(current);
      }, delay).unref?.();
    });
  }

  async #onEvent(watchId: string, event: SubscriptionEvent): Promise<void> {
    const watch = this.store.list().find((candidate) => candidate.id === watchId);
    if (!watch) return;
    const paneId = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined;
    if (paneId !== watch.paneId) return;

    if (event.event === "pane.exited" || event.event === "pane.closed") {
      await this.#settle(watch, "exited");
      return;
    }
    if (event.event !== "pane.agent_status_changed") return;
    const status = event.data.agent_status as AgentStatus | undefined;
    if (!status) return;
    await this.store.update(watch.id, { lastStatus: status });
    if (status === "working" || status === "unknown") return;
    // A watch placed while the agent is still idle must not fire on the
    // very state it started in: require that we have seen it working first,
    // unless the watch was created from an already-working agent.
    const startedWorking = watch.lastStatus === "working" || watch.lastStatus === "blocked";
    if ((status === "idle" || status === "done") && !startedWorking) return;
    await this.#settle(watch, status);
  }

  async #settle(watch: WatchRecord, status: SettledStatus): Promise<void> {
    let text = "";
    try {
      const read = await this.client.readAgent(watch.paneId, {
        source: "recent",
        lines: this.options.readLines ?? 40,
      });
      text = read.text;
    } catch (error) {
      this.logger.warn?.(`herdr read ${watch.paneId} failed: ${(error as Error).message}`);
    }
    try {
      await this.notifier.notify(watch, status, formatNotification(watch, status, text));
    } catch (error) {
      this.logger.error?.(`herdr notify for ${watch.paneId} failed: ${(error as Error).message}`);
      return; // keep the watch so a later sweep or event can retry
    }
    if (status === "blocked") {
      await this.store.update(watch.id, { lastStatus: "blocked" });
      return; // still the same task; finish or exit will follow
    }
    this.#subscriptions.get(watch.id)?.close();
    this.#subscriptions.delete(watch.id);
    await this.store.remove(watch.id);
  }

  async #sweepDeadlines(): Promise<void> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    for (const watch of this.store.list()) {
      if (Date.parse(watch.deadlineAt) <= now) await this.#settle(watch, "timed_out");
    }
  }
}
