import type { Notifier, SettledStatus } from "../core/watcher.js";
import type { WatchRecord } from "../core/watch-store.js";
import type { HostApi, HostHeartbeatRunResult } from "./host-api.js";

/**
 * The heartbeat runner treats the literal reason `wake` as a "wake payload":
 * that is what lets the turn run even when the agent's HEARTBEAT.md is empty
 * or missing (otherwise the runner answers `skipped: empty-heartbeat-file`).
 * It is the same convention `openclaw system event --mode now` relies on.
 */
const WAKE_REASON = "wake";

/**
 * A watch record plus the optional per-event counter the watcher maintains.
 * Declared structurally so the store stays free to add (or not add) the field.
 */
type NotifiableWatch = WatchRecord & { notificationSeq?: number };

export interface OpenClawNotifierOptions {
  /** Where the heartbeat turn delivers. `last` = the session's last active channel. */
  heartbeatTarget?: string;
}

/** Prompt carried by the injection; the heartbeat turn is what reads it. */
const RELAY_HEADER =
  "[Herdr watch event] Relay the following to the user now, as-is (short, phone-friendly). Do not poll the terminal yourself.";

/** Thrown when the host declined to run the turn right now; the watcher retries. */
export class DeliverySkippedError extends Error {
  constructor(
    reason: string,
    readonly retryAtMs?: number,
  ) {
    super(reason);
    this.name = "DeliverySkippedError";
  }
}

/**
 * Delivers a watch result back to the OpenClaw session that asked for it.
 * Two steps, in this order:
 *  1. `enqueueNextTurnInjection` stores the text as durable context in that
 *     session. It is idempotent per key, and the key carries the watch's
 *     per-event sequence so two legitimate `blocked` events for the same watch
 *     never collapse into one. `enqueued: false` with an id means the key is
 *     already queued (a retry), which is fine; `enqueued: false` with no id
 *     means the host dropped it, so we throw and the watcher keeps the watch.
 *  2. `runtime.system.enqueueSystemEvent` queues the same text as a system
 *     event for that session (keyed, replaceable), which is the payload a
 *     wake heartbeat reads.
 *  3. `runtime.system.runHeartbeatOnce({ reason: "wake", sessionKey,
 *     agentId })` runs one agent turn in that session immediately, regardless
 *     of whether periodic heartbeats are configured or HEARTBEAT.md exists.
 *     That turn consumes the event and the injection and delivers its reply
 *     to the session's channel. Only `status: "ran"` counts as delivered;
 *     `skipped` (session busy, cooldown) and `failed` throw so the watcher's
 *     pending-delivery retry engages.
 *
 * Why not `chat.send`: the Gateway's in-process request seam and the
 * `chat.send` method are reserved for bundled or trusted official plugins
 * ("Gateway requests are only available to bundled or trusted official
 * plugins"), and granting them would let a plugin write into arbitrary
 * conversations. The heartbeat runtime is the public seam for exactly this
 * "wake this session now" need.
 *
 * Keys are derived only from durable state (no clock, no randomness), so a
 * retry after a restart produces the same key and cannot double-post:
 * `herdr:<watchId>:<status>:<notificationSeq ?? 0>`.
 */
export class OpenClawNotifier implements Notifier {
  readonly #heartbeatTarget: string;

  constructor(
    private readonly api: HostApi,
    options: OpenClawNotifierOptions = {},
  ) {
    this.#heartbeatTarget = options.heartbeatTarget ?? "last";
  }

  async notify(watch: WatchRecord, status: SettledStatus, text: string): Promise<void> {
    const seq = (watch as NotifiableWatch).notificationSeq ?? 0;
    const idempotencyKey = `herdr:${watch.id}:${status}:${seq}`;

    const injection = await this.api.session.workflow.enqueueNextTurnInjection({
      sessionKey: watch.sessionKey,
      ...(watch.agentId ? { agentId: watch.agentId } : {}),
      text: [RELAY_HEADER, text].join("\n"),
      idempotencyKey,
      placement: "append_context",
      ttlMs: 24 * 60 * 60 * 1000,
      metadata: { kind: "herdr-watch", watchId: watch.id, paneId: watch.paneId, status },
    });
    if (injection.enqueued) {
      this.api.logger.info?.(`herdr: queued ${status} for ${watch.paneId} → ${injection.sessionKey} (${injection.id})`);
    } else if (injection.id) {
      this.api.logger.info?.(`herdr: ${status} for ${watch.paneId} was already queued (${injection.id})`);
    } else {
      throw new Error(`herdr: host refused the ${status} injection for ${watch.paneId} (key ${idempotencyKey})`);
    }

    this.#queueSystemEvent(watch, status, text, idempotencyKey);
    await this.#runTurn(watch, status);
  }

  /** Best effort: the injection already carries the text durably. */
  #queueSystemEvent(watch: WatchRecord, status: SettledStatus, text: string, contextKey: string): void {
    const enqueue = this.api.runtime?.system?.enqueueSystemEvent;
    if (!enqueue) return;
    try {
      enqueue([RELAY_HEADER, text].join("\n"), { sessionKey: watch.sessionKey, contextKey, replace: true });
    } catch (error) {
      this.api.logger.warn?.(`herdr: system event for ${watch.paneId} (${status}) was not queued: ${describe(error)}`);
    }
  }

  /** Runs the turn that makes the message visible. Throws unless it ran. */
  async #runTurn(watch: WatchRecord, status: SettledStatus): Promise<void> {
    const run = this.api.runtime?.system?.runHeartbeatOnce;
    if (!run) {
      throw new Error(
        `herdr: this host exposes no runtime.system.runHeartbeatOnce, so the ${status} event for ${watch.paneId} stays queued until the session's next turn`,
      );
    }
    let result: HostHeartbeatRunResult;
    try {
      this.api.logger.info?.(`herdr: waking ${watch.sessionKey} for ${status} ${watch.paneId}`);
      result = await run({
        reason: WAKE_REASON,
        sessionKey: watch.sessionKey,
        ...(watch.agentId ? { agentId: watch.agentId } : {}),
        heartbeat: { target: this.#heartbeatTarget },
      });
    } catch (error) {
      throw new Error(`herdr: heartbeat turn for ${watch.paneId} threw: ${describe(error)}`);
    }
    if (result.status === "ran") {
      this.api.logger.info?.(`herdr: delivered ${status} for ${watch.paneId} in ${result.durationMs}ms`);
      return;
    }
    if (result.status === "skipped") {
      throw new DeliverySkippedError(
        `herdr: heartbeat turn for ${watch.paneId} was skipped (${result.reason}); will retry`,
        result.retryAtMs,
      );
    }
    throw new Error(`herdr: heartbeat turn for ${watch.paneId} failed: ${result.reason}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
