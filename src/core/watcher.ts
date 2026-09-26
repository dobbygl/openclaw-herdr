import { HerdrTransportError, type HerdrClient, type Subscription } from "../herdr/client.js";
import type { AgentInfo, AgentStatus, SubscriptionEvent } from "../herdr/types.js";
import { agentLabel, formatNotification } from "./format.js";
import { DEFAULT_LANGUAGE, messages, type Language } from "./i18n.js";
import { formatTargetRef } from "./parse.js";
import { LOCAL_SERVER_ID } from "./servers.js";
import {
  isTerminalSettledStatus,
  type PendingDelivery,
  type PaneRef,
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
 * Picks the client for one server. It is deliberately **synchronous**: a
 * subscription must be registered without an `await` in the middle, or `stop()`
 * and a replacing `watch()` could run in the gap. A server whose client is not
 * built yet (a remote machine whose socket path is still being resolved, or one
 * that is down) answers `undefined`, which the watcher treats exactly like a
 * dropped connection: retry with backoff, settle nothing.
 */
export type WatcherClientResolver = (serverId: string) => WatcherClient | undefined;

/** A single client (every watch is local) or one resolver per server. */
export type WatcherClients = WatcherClient | WatcherClientResolver;

/**
 * A `Subscription` that may expose an acknowledgement promise. `client.ts` can
 * add `ready` (resolved when Herdr answers `subscription_started`); until it
 * does, the watcher approximates it with "first event received, or a short ack
 * timeout" so a send never blocks on a client feature that is not there yet.
 */
export type MaybeReadySubscription = Subscription & { ready?: Promise<void> };

export interface WatcherOptions {
  readLines?: number;
  /** First resubscribe delay; it doubles per consecutive failure. */
  reconnectDelayMs?: number;
  /** Ceiling for the resubscribe backoff. Default 5 minutes. */
  reconnectMaxDelayMs?: number;
  sweepIntervalMs?: number;
  /** Fallback wait for a subscription ack when the client exposes no `ready`. */
  subscribeAckTimeoutMs?: number;
  /** Backoff per failed delivery attempt; the last entry repeats. */
  deliveryBackoffMs?: number[];
  /**
   * Display label of a server, for the qualified pane refs in notifications
   * (`w1:p1@buildbox`). Must be synchronous and must not throw; the profile id
   * is a fine fallback.
   */
  serverLabel?: (serverId: string) => string | undefined;
  /**
   * Called when a server looks unhealthy (a subscription died, or its client
   * could not be built). The registry uses it to mark the machine `down` and to
   * re-resolve its socket path on the next attempt.
   */
  onServerError?: (serverId: string, reason: string) => void;
  now?: () => Date;
}

const KNOWN_STATUSES: readonly string[] = ["idle", "working", "blocked", "done", "unknown"];
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000];
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
/** A machine may be off for hours; keep trying, but no faster than this. */
const DEFAULT_RECONNECT_MAX_DELAY_MS = 300_000;

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
 *  - A watch belongs to one server (`local` or a machine profile id) and every
 *    call goes through that server's client. A server that cannot be reached
 *    keeps its watches pending — no settle, no notification — and is retried
 *    with a backoff capped at a few minutes.
 */
export class HerdrWatcher {
  #subscriptions = new Map<string, LiveSubscription>();
  #queues = new Map<string, Promise<void>>();
  #reconnectTimers = new Set<NodeJS.Timeout>();
  /** Consecutive resubscribe failures per watch; drives the backoff. */
  #reconnectAttempts = new Map<string, number>();
  #sweepTimer: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #clientFor: WatcherClientResolver;

  constructor(
    clients: WatcherClients,
    private readonly store: WatchStore,
    private readonly notifier: Notifier,
    private readonly logger: WatcherLogger = {},
    private readonly options: WatcherOptions = {},
  ) {
    this.#clientFor = typeof clients === "function" ? clients : () => clients;
  }

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
    this.#reconnectAttempts.clear();
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
    /** Server the pane lives on. Defaults to `local`. */
    serverId?: string;
    sessionKey: string;
    agentId?: string;
    promptPreview: string;
    timeoutMinutes: number;
    /** Language of the reply that asked; persisted so the notification matches it. */
    language: Language;
  }): Promise<WatchRecord> {
    const now = this.#now();
    const status = this.#normalizeStatus(input.agent.agent_status, input.agent.pane_id);
    const seq = typeof input.agent.state_change_seq === "number" ? input.agent.state_change_seq : undefined;
    const { record, replaced } = await this.store.add({
      ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      paneId: input.agent.pane_id,
      terminalId: input.agent.terminal_id,
      agentLabel: agentLabel(input.agent, messages(input.language).agentFallback),
      language: input.language,
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
      this.logger.info?.(`herdr watch ${this.#ref(record)}: replaced the watch of session ${replaced.sessionKey}`);
    }
    try {
      const live = this.#subscribe(record);
      if (!live) {
        throw new Error(`${this.#serverName(record.serverId)} is not reachable, so I cannot watch ${this.#ref(record)}`);
      }
      await live.ready;
    } catch (error) {
      // No half-registered watch: either it is stored and listening, or gone.
      await this.#cancelNow(record.id);
      throw error;
    }
    return record;
  }

  /**
   * Removes watches on one pane of one server. With a `sessionKey` only that
   * caller's watch goes away, so one chat cannot silence another's (finding
   * 10). Returns how many watches were removed.
   */
  async unwatch(ref: PaneRef, sessionKey?: string): Promise<number> {
    const targets = this.store
      .listByPane(ref)
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

  /**
   * Opens (or reopens) the subscription for one watch. Returns undefined when
   * the watch's server has no client right now: the watch stays exactly as it
   * is and a resubscribe is scheduled with the backoff.
   */
  #subscribe(watch: WatchRecord): LiveSubscription | undefined {
    this.#closeSubscription(watch.id);
    const client = this.#clientFor(watch.serverId);
    if (!client) {
      const reason = `${this.#serverName(watch.serverId)} is not reachable`;
      this.logger.warn?.(`herdr watch ${this.#ref(watch)}: ${reason}; nothing settles until it answers again`);
      this.options.onServerError?.(watch.serverId, reason);
      this.#scheduleResubscribe(watch.id);
      return undefined;
    }
    let markAcked!: () => void;
    const acked = new Promise<void>((resolve) => {
      markAcked = resolve;
    });
    const subscription = client.subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: watch.paneId },
        { type: "pane.exited" },
        { type: "pane.closed" },
      ],
      (event) => {
        markAcked();
        this.#onEvent(watch.id, event);
      },
      (error) => this.logger.warn?.(`herdr watch ${this.#ref(watch)}: ${error.message}`),
    ) as MaybeReadySubscription;

    const ackTimeout = this.options.subscribeAckTimeoutMs ?? 500;
    const ready = (subscription.ready ?? Promise.race([acked, this.#delay(ackTimeout)])).then(
      () => {
        // The server is streaming: forget the previous failures.
        this.#reconnectAttempts.delete(watch.id);
        return undefined;
      },
      (error: unknown) => {
        this.logger.warn?.(`herdr watch ${this.#ref(watch)}: subscription ack failed: ${message(error)}`);
        // Herdr refusing the subscription (an unknown pane) says nothing about
        // the machine's health; only a transport failure does.
        this.#reportTransportFailure(watch.serverId, error);
      },
    );
    const live: LiveSubscription = { subscription, ready };
    this.#subscriptions.set(watch.id, live);

    void subscription.closed
      .then(() => {
        if (this.#stopped || this.#subscriptions.get(watch.id) !== live) return;
        this.#subscriptions.delete(watch.id);
        this.#scheduleResubscribe(watch.id);
      })
      .catch((error: unknown) =>
        this.logger.error?.(`herdr watch ${this.#ref(watch)}: reconnect bookkeeping failed: ${message(error)}`),
      );
    return live;
  }

  /**
   * Resubscribes after a delay that doubles per consecutive failure, capped by
   * `reconnectMaxDelayMs`: a machine that is off for the afternoon must not be
   * hammered, and must still be picked up when it comes back.
   */
  #scheduleResubscribe(watchId: string): void {
    if (this.#stopped) return;
    const attempts = (this.#reconnectAttempts.get(watchId) ?? 0) + 1;
    this.#reconnectAttempts.set(watchId, attempts);
    const base = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const cap = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(base * 2 ** (attempts - 1), cap);
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(timer);
      const current = this.store.byId(watchId);
      if (!current || this.#stopped) return;
      this.logger.info?.(`herdr watch ${this.#ref(current)}: resubscribing (attempt ${attempts})`);
      if (!this.#subscribe(current)) return;
      // A reconnect is a blind spot: re-sync from Herdr (findings 1, 9).
      void this.#enqueue(current.id, () => this.#reconcileById(current.id, "reconnect"));
    }, delay);
    this.#reconnectTimers.add(timer);
    timer.unref?.();
  }

  /** Unqueued teardown, for callers that already run inside the watch's queue. */
  async #cancelNow(watchId: string): Promise<void> {
    this.#closeSubscription(watchId);
    this.#reconnectAttempts.delete(watchId);
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
      this.logger.info?.(`herdr watch ${this.#ref(current)}: Herdr cannot classify the pane right now`);
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
    const client = this.#clientFor(watch.serverId);
    if (!client) {
      // The server is unreachable, so the hint is all we have — and a hint is
      // never enough to settle. Stay pending until the machine answers again.
      this.logger.info?.(
        `herdr watch ${this.#ref(watch)}: ${this.#serverName(watch.serverId)} is not reachable (${reason}); staying pending`,
      );
      this.options.onServerError?.(watch.serverId, `${this.#serverName(watch.serverId)} is not reachable`);
      return;
    }
    let info: AgentInfo | undefined;
    try {
      info = await client.getAgent(watch.paneId);
    } catch (error) {
      this.logger.warn?.(`herdr watch ${this.#ref(watch)}: agent.get (${reason}) failed: ${message(error)}`);
      // A pane Herdr refuses to describe is not a machine that is down.
      this.#reportTransportFailure(watch.serverId, error);
    }
    if (!info) {
      // The local fallback: a blip in the socket must not swallow a completion
      // we were told about. A machine is different — an unconfirmed event is
      // all we have and it is not enough, so the watch stays pending until the
      // machine answers `agent.get` again (issue 5).
      if (hint && watch.serverId === LOCAL_SERVER_ID) await this.#applyStatus(watch, hint, undefined, hint);
      else if (hint) {
        this.logger.info?.(
          `herdr watch ${this.#ref(watch)}: ${hint} seen but ${this.#serverName(watch.serverId)} could not confirm it; staying pending`,
        );
      }
      return;
    }
    // Occupant change: this pane runs a different terminal now, so whatever it
    // shows is somebody else's work. Report it, attribute nothing (finding 9).
    if (watch.terminalId && info.terminal_id && info.terminal_id !== watch.terminalId) {
      this.logger.info?.(
        `herdr watch ${this.#ref(watch)}: terminal changed ${watch.terminalId} → ${info.terminal_id}`,
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
      this.logger.info?.(`herdr watch ${this.#ref(watch)}: Herdr cannot classify the pane right now`);
      return;
    }
    if (!sawWorking) {
      this.logger.info?.(
        `herdr watch ${this.#ref(watch)}: ${status} with no evidence the task ran (seq ${String(watch.seqAtStart)} → ${String(seq)}); waiting`,
      );
      return;
    }
    await this.#settle(updated, status);
  }

  async #settle(watch: WatchRecord, status: SettledStatus): Promise<void> {
    const terminal = isTerminalSettledStatus(status);
    if (watch.settledStatus && isTerminalSettledStatus(watch.settledStatus)) {
      this.logger.info?.(
        `herdr watch ${this.#ref(watch)}: ignoring ${status}, already settled as ${watch.settledStatus}`,
      );
      return;
    }
    let current: WatchRecord = watch;
    if (watch.pendingDelivery) {
      if (!terminal) {
        this.logger.warn?.(`herdr watch ${this.#ref(watch)}: ${status} skipped, a notification is still undelivered`);
        return;
      }
      // We are about to take the delivery slot: give what is in it one last
      // chance, so a `blocked` question is not silently dropped.
      const flushed = await this.#flushPending(watch, true);
      if (!flushed) return;
      current = flushed;
      if (current.pendingDelivery) {
        this.logger.info?.(
          `herdr watch ${this.#ref(current)}: ${status} supersedes the undelivered ${current.pendingDelivery.status} notification`,
        );
      }
    }

    const notificationSeq = current.notificationSeq + 1;
    const tail = await this.#readTail(current);
    const observed: WatchRecord = { ...current, notificationSeq };
    const pending: PendingDelivery = {
      status,
      // Remote panes are named with their machine, so the ref can be pasted back.
      text: formatNotification(messages(current.language ?? DEFAULT_LANGUAGE), observed, status, tail, this.#ref(current)),
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
        `herdr watch ${this.#ref(watch)}: notify (${pending.status}) failed, attempt ${attempts}, retry in ${delay}ms: ${message(error)}`,
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
          `herdr watch ${this.#ref(current)}: dropping the undelivered ${current.pendingDelivery.status} notification after ${current.pendingDelivery.attempts} attempts; the watch deadline passed`,
        );
        await this.#cancelNow(current.id);
      }
      return;
    }
    if (expired) await this.#settle(current, "timed_out");
  }

  async #readTail(watch: WatchRecord): Promise<string> {
    const client = this.#clientFor(watch.serverId);
    if (!client) return "";
    try {
      const read = await client.readAgent(watch.paneId, {
        source: "recent",
        lines: this.options.readLines ?? 40,
      });
      return read.text;
    } catch (error) {
      this.logger.warn?.(`herdr read ${this.#ref(watch)} failed: ${message(error)}`);
      return "";
    }
  }

  /** `w1:p1` locally, `w1:p1@buildbox` on a machine: what the operator can copy. */
  #ref(watch: PaneRef): string {
    return formatTargetRef(watch.paneId, this.#serverSuffix(watch.serverId));
  }

  #serverSuffix(serverId: string): string | undefined {
    if (serverId === LOCAL_SERVER_ID) return undefined;
    return this.options.serverLabel?.(serverId) ?? serverId;
  }

  /** How a server is named in a sentence. */
  #serverName(serverId: string): string {
    return this.#serverSuffix(serverId) ?? "the local Herdr";
  }

  /**
   * Health signal, filtered: only a transport failure says something about the
   * server. `HerdrRequestError` means Herdr answered and refused, which is a
   * pane problem, and marking the machine down for it would push every other
   * watch on it into backoff.
   */
  #reportTransportFailure(serverId: string, error: unknown): void {
    if (serverId === LOCAL_SERVER_ID) return;
    if (!(error instanceof HerdrTransportError)) return;
    this.options.onServerError?.(serverId, message(error));
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
