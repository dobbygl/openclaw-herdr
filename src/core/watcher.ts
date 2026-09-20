import type { HerdrClient, Subscription } from "../herdr/client.js";
import type { AgentInfo, AgentStatus, SubscriptionEvent } from "../herdr/types.js";
import { formatNotification } from "./format.js";
import {
  isTerminalSettledStatus,
  type PendingDelivery,
  type SettledStatus,
  type WatchPatch,
  type WatchRecord,
  type WatchStore,
} from "./watch-store.js";

export type { SettledStatus } from "./watch-store.js";

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

/**
 * A `Subscription` that may expose an acknowledgement promise. `client.ts` can
 * add `ready` (resolved when Herdr answers `subscription_started`); until it
 * does, the watcher approximates it with "first event received, or a short ack
 * timeout" so a send never blocks on a client feature that is not there yet.
 */
export type MaybeReadySubscription = Subscription & { ready?: Promise<void> };

export interface WatcherOptions {
  readLines?: number;
  reconnectDelayMs?: number;
  sweepIntervalMs?: number;
  /** Fallback wait for a subscription ack when the client exposes no `ready`. */
  subscribeAckTimeoutMs?: number;
  /** Backoff per failed delivery attempt; the last entry repeats. */
  deliveryBackoffMs?: number[];
  now?: () => Date;
}

const KNOWN_STATUSES: readonly string[] = ["idle", "working", "blocked", "done", "unknown"];
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

interface LiveSubscription {
  subscription: MaybeReadySubscription;
  /** Resolves once we believe Herdr is streaming events for this pane. */
  ready: Promise<void>;
}

/**
 * Keeps one Herdr event subscription per watched pane and turns
 * `pane.agent_status_changed` into exactly one chat notification when the
 * agent reaches idle/done (finished) or blocked (needs input).
 *
 * Rules that the details below implement:
 *  - Herdr is the source of truth. Events only say "look again"; every
 *    candidate settle is confirmed with `agent.get` (status, `terminal_id`,
 *    `state_change_seq`). No terminal text is ever parsed (ADR 0001).
 *  - One watch handles one event at a time (a promise chain per watch id) and
 *    settles at most once for a terminal status, so the `done` +
 *    `pane.exited` race cannot notify twice.
 *  - Observation and delivery are separate: a notification that could not be
 *    delivered is persisted and retried; the watch outlives the failure.
 */
export class HerdrWatcher {
  #subscriptions = new Map<string, LiveSubscription>();
  #queues = new Map<string, Promise<void>>();
  #reconnectTimers = new Set<NodeJS.Timeout>();
  #sweepTimer: NodeJS.Timeout | undefined;
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
    for (const watch of this.store.list()) {
      this.#subscribe(watch);
      // Anything may have happened while we were down: ask Herdr, do not guess.
      void this.#enqueue(watch.id, () => this.#reconcileById(watch.id, "start"));
    }
    const interval = this.options.sweepIntervalMs ?? 60_000;
    this.#sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.error?.(`herdr watch sweep failed: ${message(error)}`),
      );
    }, interval);
    this.#sweepTimer.unref?.();
  }

  /** Stops accepting events and waits for the handlers already running. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    for (const timer of this.#reconnectTimers) clearTimeout(timer);
    this.#reconnectTimers.clear();
    for (const id of [...this.#subscriptions.keys()]) this.#closeSubscription(id);
    await this.drain();
  }

  /** Waits for every in-flight watch handler. Also the test seam for events. */
  async drain(): Promise<void> {
    for (let round = 0; round < 50 && this.#queues.size > 0; round += 1) {
      await Promise.allSettled([...this.#queues.values()]);
    }
  }

  /**
   * Registers a watch and confirms its subscription before returning, so the
   * caller can prompt knowing that nobody can miss the answer (finding 1).
   */
  async watch(input: {
    agent: AgentInfo;
    sessionKey: string;
    agentId?: string;
    promptPreview: string;
    timeoutMinutes: number;
  }): Promise<WatchRecord> {
    const now = this.#now();
    const status = this.#normalizeStatus(input.agent.agent_status, input.agent.pane_id);
    const seq = typeof input.agent.state_change_seq === "number" ? input.agent.state_change_seq : undefined;
    const { record, replaced } = await this.store.add({
      paneId: input.agent.pane_id,
      terminalId: input.agent.terminal_id,
      agentLabel: input.agent.name ?? input.agent.agent ?? "agent",
      sessionKey: input.sessionKey,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      promptPreview: input.promptPreview,
      deadlineAt: new Date(now.getTime() + input.timeoutMinutes * 60_000).toISOString(),
      ...(seq !== undefined ? { seqAtStart: seq, lastSeq: seq } : {}),
      lastStatus: status,
      sawWorking: status === "working" || status === "blocked",
    });
    // The replaced watch and its subscription die together (finding 7).
    if (replaced) {
      this.#closeSubscription(replaced.id);
      this.logger.info?.(`herdr watch ${record.paneId}: replaced the watch of session ${replaced.sessionKey}`);
    }
    try {
      const live = this.#subscribe(record);
      await live.ready;
    } catch (error) {
      // No half-registered watch: either it is stored and listening, or gone.
      await this.#cancelNow(record.id);
      throw error;
    }
    return record;
  }

  /**
   * Removes watches on a pane. With a `sessionKey` only that caller's watch
   * goes away, so one chat cannot silence another's (finding 10). Returns how
   * many watches were removed.
   */
  async unwatch(paneId: string, sessionKey?: string): Promise<number> {
    const targets = this.store
      .listByPane(paneId)
      .filter((watch) => sessionKey === undefined || watch.sessionKey === sessionKey);
    for (const watch of targets) await this.cancel(watch.id);
    return targets.length;
  }

  /**
   * Drops one watch without notifying (used when a send turns out not to have
   * happened). Queued behind whatever handler is running for that watch, so a
   * cancel never tears the record out from under an event in flight.
   */
  async cancel(watchId: string): Promise<void> {
    await this.#enqueue(watchId, () => this.#cancelNow(watchId));
  }

  /** Asks Herdr about the pane and applies the outcome to that watch. */
  async reconcile(watchId: string, reason = "manual"): Promise<void> {
    await this.#enqueue(watchId, () => this.#reconcileById(watchId, reason));
  }

  /** Retries pending deliveries and fires watch deadlines. Safe to call by hand. */
  async sweep(): Promise<void> {
    if (this.#stopped) return;
    const watches = this.store.list();
    await Promise.all(watches.map((watch) => this.#enqueue(watch.id, () => this.#sweepOne(watch.id))));
  }

  // ---- internals ----

  #subscribe(watch: WatchRecord): LiveSubscription {
    this.#closeSubscription(watch.id);
    let markAcked!: () => void;
    const acked = new Promise<void>((resolve) => {
      markAcked = resolve;
    });
    const subscription = this.client.subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: watch.paneId },
        { type: "pane.exited" },
        { type: "pane.closed" },
      ],
      (event) => {
        markAcked();
        this.#onEvent(watch.id, event);
      },
      (error) => this.logger.warn?.(`herdr watch ${watch.paneId}: ${error.message}`),
    ) as MaybeReadySubscription;

    const ackTimeout = this.options.subscribeAckTimeoutMs ?? 500;
    const ready = (subscription.ready ?? Promise.race([acked, this.#delay(ackTimeout)])).then(
      () => undefined,
      (error: unknown) => {
        this.logger.warn?.(`herdr watch ${watch.paneId}: subscription ack failed: ${message(error)}`);
      },
    );
    const live: LiveSubscription = { subscription, ready };
    this.#subscriptions.set(watch.id, live);

    void subscription.closed
      .then(() => {
        if (this.#stopped || this.#subscriptions.get(watch.id) !== live) return;
        this.#subscriptions.delete(watch.id);
        const delay = this.options.reconnectDelayMs ?? 2_000;
        const timer = setTimeout(() => {
          this.#reconnectTimers.delete(timer);
          const current = this.store.byId(watch.id);
          if (!current || this.#stopped) return;
          this.logger.info?.(`herdr watch ${current.paneId}: resubscribing`);
          this.#subscribe(current);
          // A reconnect is a blind spot: re-sync from Herdr (findings 1, 9).
          void this.#enqueue(current.id, () => this.#reconcileById(current.id, "reconnect"));
        }, delay);
        this.#reconnectTimers.add(timer);
        timer.unref?.();
      })
      .catch((error: unknown) =>
        this.logger.error?.(`herdr watch ${watch.paneId}: reconnect bookkeeping failed: ${message(error)}`),
      );
    return live;
  }

  /** Unqueued teardown, for callers that already run inside the watch's queue. */
  async #cancelNow(watchId: string): Promise<void> {
    this.#closeSubscription(watchId);
    await this.store.remove(watchId);
  }

  #closeSubscription(watchId: string): void {
    const live = this.#subscriptions.get(watchId);
    if (!live) return;
    // Delete first: the `closed` handler must not schedule a reconnect for it.
    this.#subscriptions.delete(watchId);
    try {
      live.subscription.close();
    } catch (error) {
      this.logger.warn?.(`herdr watch ${watchId}: closing the subscription failed: ${message(error)}`);
    }
  }

  #onEvent(watchId: string, event: SubscriptionEvent): void {
    if (this.#stopped) return;
    void this.#enqueue(watchId, () => this.#handleEvent(watchId, event));
  }

  /** One handler at a time per watch; errors are logged, never thrown at a socket callback. */
  #enqueue(watchId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(watchId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.logger.error?.(`herdr watch ${watchId}: handler failed: ${message(error)}`);
    });
    this.#queues.set(watchId, next);
    void next.then(() => {
      if (this.#queues.get(watchId) === next) this.#queues.delete(watchId);
    });
    return next;
  }

  async #handleEvent(watchId: string, event: SubscriptionEvent): Promise<void> {
    const watch = this.store.byId(watchId);
    if (!watch) return;
    const paneId = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined;
    if (paneId !== watch.paneId) return;

    // An event is a good moment to retry a delivery that failed earlier, but
    // the backoff still holds: a burst of events must not burn the attempts.
    const current = await this.#flushPending(watch, false);
    if (!current) return;

    if (event.event === "pane.exited" || event.event === "pane.closed") {
      await this.#settle(current, "exited");
      return;
    }
    if (event.event !== "pane.agent_status_changed") return;

    const status = this.#normalizeStatus(event.data.agent_status, current.paneId);
    if (status === "working") {
      await this.store.update(current.id, { lastStatus: "working", sawWorking: true });
      return;
    }
    if (status === "unknown") {
      // Uncertainty, not evidence: keep `sawWorking` so a later idle still counts.
      await this.store.update(current.id, { lastStatus: "unknown" });
      this.logger.info?.(`herdr watch ${current.paneId}: Herdr cannot classify the pane right now`);
      return;
    }
    // idle / done / blocked: never settle on the event alone, ask Herdr.
    await this.#reconcile(current, `event:${status}`, status);
  }

  async #reconcileById(watchId: string, reason: string): Promise<void> {
    const watch = this.store.byId(watchId);
    if (!watch) return;
    const flushed = await this.#flushPending(watch, true);
    if (!flushed) return;
    await this.#reconcile(flushed, reason);
  }

  /**
   * Asks Herdr for the current truth about the pane and applies it.
   *
   * `hint` is the status an event claimed; it is only used when `agent.get`
   * cannot be reached, so a transport blip does not swallow a completion.
   */
  async #reconcile(watch: WatchRecord, reason: string, hint?: AgentStatus): Promise<void> {
    let info: AgentInfo | undefined;
    try {
      info = await this.client.getAgent(watch.paneId);
    } catch (error) {
      this.logger.warn?.(`herdr watch ${watch.paneId}: agent.get (${reason}) failed: ${message(error)}`);
    }
    if (!info) {
      if (hint) await this.#applyStatus(watch, hint, undefined, hint);
      return;
    }
    // Occupant change: this pane runs a different terminal now, so whatever it
    // shows is somebody else's work. Report it, attribute nothing (finding 9).
    if (watch.terminalId && info.terminal_id && info.terminal_id !== watch.terminalId) {
      this.logger.info?.(
        `herdr watch ${watch.paneId}: terminal changed ${watch.terminalId} → ${info.terminal_id}`,
      );
      await this.#settle(watch, "occupant_changed");
      return;
    }
    const status = this.#normalizeStatus(info.agent_status, watch.paneId);
    const seq = typeof info.state_change_seq === "number" ? info.state_change_seq : undefined;
    await this.#applyStatus(watch, status, seq, hint);
  }

  /**
   * Decides what a confirmed status means for this watch.
   *
   * `idle` right after a prompt does not prove completion: the agent may not
   * have started yet. What proves it is that Herdr's `state_change_seq` moved
   * past the value captured before the prompt while the agent is idle/done –
   * the task ran and came back. When either sequence number is missing we
   * claim nothing and wait for a `working` observation instead.
   */
  async #applyStatus(
    watch: WatchRecord,
    status: AgentStatus,
    seq: number | undefined,
    hint: AgentStatus | undefined,
  ): Promise<void> {
    const advanced = seq !== undefined && watch.seqAtStart !== undefined && seq > watch.seqAtStart;
    const sawWorking =
      watch.sawWorking ||
      advanced ||
      status === "working" ||
      status === "blocked" ||
      hint === "working" ||
      hint === "blocked";
    const patch: Omit<WatchPatch, "pendingDelivery"> = {
      lastStatus: status,
      sawWorking,
      ...(seq !== undefined ? { lastSeq: seq } : {}),
    };
    if (!(await this.store.update(watch.id, patch))) return;
    const updated: WatchRecord = { ...watch, ...patch };

    if (status === "blocked") {
      await this.#settle(updated, "blocked");
      return;
    }
    if (status === "working") return;
    if (status === "unknown") {
      this.logger.info?.(`herdr watch ${watch.paneId}: Herdr cannot classify the pane right now`);
      return;
    }
    if (!sawWorking) {
      this.logger.info?.(
        `herdr watch ${watch.paneId}: ${status} with no evidence the task ran (seq ${String(watch.seqAtStart)} → ${String(seq)}); waiting`,
      );
      return;
    }
    await this.#settle(updated, status);
  }

  async #settle(watch: WatchRecord, status: SettledStatus): Promise<void> {
    const terminal = isTerminalSettledStatus(status);
    if (watch.settledStatus && isTerminalSettledStatus(watch.settledStatus)) {
      this.logger.info?.(
        `herdr watch ${watch.paneId}: ignoring ${status}, already settled as ${watch.settledStatus}`,
      );
      return;
    }
    let current: WatchRecord = watch;
    if (watch.pendingDelivery) {
      if (!terminal) {
        this.logger.warn?.(`herdr watch ${watch.paneId}: ${status} skipped, a notification is still undelivered`);
        return;
      }
      // We are about to take the delivery slot: give what is in it one last
      // chance, so a `blocked` question is not silently dropped.
      const flushed = await this.#flushPending(watch, true);
      if (!flushed) return;
      current = flushed;
      if (current.pendingDelivery) {
        this.logger.info?.(
          `herdr watch ${current.paneId}: ${status} supersedes the undelivered ${current.pendingDelivery.status} notification`,
        );
      }
    }

    const notificationSeq = current.notificationSeq + 1;
    const tail = await this.#readTail(current.paneId);
    const observed: WatchRecord = { ...current, notificationSeq };
    const pending: PendingDelivery = {
      status,
      text: formatNotification(observed, status, tail),
      attempts: 0,
      nextAttemptAt: this.#now().toISOString(),
    };
    const patch: WatchPatch = {
      notificationSeq,
      pendingDelivery: pending,
      ...(terminal ? { settledStatus: status } : {}),
    };
    if (!(await this.store.update(watch.id, patch))) return;
    await this.#attemptDelivery({ ...observed, ...patch, pendingDelivery: pending }, pending);
  }

  /**
   * Tries to hand one notification to the notifier. The watch is only removed
   * once `notify()` resolves (finding 3): a failure is persisted with a
   * backoff and retried by the sweep and by later events, for as long as the
   * watch lives. Only the watch deadline ends the retries, in `#sweepOne`.
   */
  async #attemptDelivery(watch: WatchRecord, pending: PendingDelivery): Promise<WatchRecord | undefined> {
    try {
      await this.notifier.notify(watch, pending.status, pending.text);
    } catch (error) {
      const attempts = pending.attempts + 1;
      const backoff = this.options.deliveryBackoffMs ?? DEFAULT_BACKOFF_MS;
      const delay = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 1_000;
      const next: PendingDelivery = {
        ...pending,
        attempts,
        nextAttemptAt: new Date(this.#now().getTime() + delay).toISOString(),
      };
      this.logger.warn?.(
        `herdr watch ${watch.paneId}: notify (${pending.status}) failed, attempt ${attempts}, retry in ${delay}ms: ${message(error)}`,
      );
      if (!(await this.store.update(watch.id, { pendingDelivery: next }))) return undefined;
      return { ...watch, pendingDelivery: next };
    }

    if (!(await this.store.update(watch.id, { pendingDelivery: null }))) return undefined;
    if (isTerminalSettledStatus(pending.status)) {
      this.#closeSubscription(watch.id);
      await this.store.remove(watch.id);
      return undefined;
    }
    // `blocked` was delivered; the same task continues, so keep watching.
    const { pendingDelivery: _delivered, ...rest } = watch;
    return rest;
  }

  /** Returns the current record, or undefined when the watch is gone. */
  async #flushPending(watch: WatchRecord, force: boolean): Promise<WatchRecord | undefined> {
    const pending = watch.pendingDelivery;
    if (!pending) return watch;
    if (!force && Date.parse(pending.nextAttemptAt) > this.#now().getTime()) return watch;
    return this.#attemptDelivery(watch, pending);
  }

  async #sweepOne(watchId: string): Promise<void> {
    const watch = this.store.byId(watchId);
    if (!watch) return;
    const current = await this.#flushPending(watch, false);
    if (!current) return;
    const expired = Date.parse(current.deadlineAt) <= this.#now().getTime();
    if (current.settledStatus && isTerminalSettledStatus(current.settledStatus)) {
      // Already settled: never notify twice, just keep trying to deliver. The
      // watch deadline is the only thing that ends it, so a notifier that is
      // broken for good cannot leave the record behind for ever.
      if (expired && current.pendingDelivery) {
        this.logger.error?.(
          `herdr watch ${current.paneId}: dropping the undelivered ${current.pendingDelivery.status} notification after ${current.pendingDelivery.attempts} attempts; the watch deadline passed`,
        );
        await this.#cancelNow(current.id);
      }
      return;
    }
    if (expired) await this.#settle(current, "timed_out");
  }

  async #readTail(paneId: string): Promise<string> {
    try {
      const read = await this.client.readAgent(paneId, {
        source: "recent",
        lines: this.options.readLines ?? 40,
      });
      return read.text;
    } catch (error) {
      this.logger.warn?.(`herdr read ${paneId} failed: ${message(error)}`);
      return "";
    }
  }

  /** Only Herdr's five documented states are accepted; anything else is `unknown` (finding 8). */
  #normalizeStatus(raw: unknown, paneId: string): AgentStatus {
    if (typeof raw === "string" && KNOWN_STATUSES.includes(raw)) return raw as AgentStatus;
    this.logger.warn?.(`herdr watch ${paneId}: unexpected agent status ${JSON.stringify(raw)}; treating as unknown`);
    return "unknown";
  }

  #delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
