import { spawn } from "node:child_process";
import type { Notifier, SettledStatus } from "../core/watcher.js";
import type { WatchRecord } from "../core/watch-store.js";
import type { HostApi } from "./host-api.js";

/**
 * A watch record plus the optional per-event counter the watcher maintains.
 * Declared structurally so the store stays free to add (or not add) the field.
 */
type NotifiableWatch = WatchRecord & { notificationSeq?: number };

export interface DeliveryCommandResult {
  /** Exit code, or `null` when the child was killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DeliveryCommandRunner = (
  bin: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<DeliveryCommandResult>;

export interface OpenClawNotifierOptions {
  /** `openclaw` executable for the CLI delivery path; PATH lookup when unset. */
  openclawBin?: string;
  /** Budget for one delivery attempt. */
  deliveryTimeoutMs?: number;
  /** Injection point for tests; defaults to spawning the CLI asynchronously. */
  runCommand?: DeliveryCommandRunner;
}

const CHAT_SEND_METHOD = "chat.send";
/** Prompt for the turn we start ourselves: relay it now. */
const RELAY_HEADER =
  "[Herdr watch event] Relay the following to the user as-is (short, phone-friendly). Do not poll the terminal yourself.";
/**
 * Prompt for the durable copy. The delivery turn appends this same event as
 * context, so the queued copy must not read as a second event to report.
 */
const CONTEXT_HEADER =
  "[Herdr watch event · queued copy] This event was already dispatched as its own turn. Relay it to the user only if you have not relayed it yet, as-is (short, phone-friendly). Do not poll the terminal yourself.";
const MAX_CAPTURED_OUTPUT = 8 * 1024;

/**
 * Delivers a watch result back to the OpenClaw session that asked for it.
 *
 * Three steps, in this order:
 *
 *  1. `enqueueNextTurnInjection` stores the text as durable context, so a turn
 *     that starts for any other reason still carries it (and it survives a
 *     Gateway restart). It is idempotent per key, so the key carries the
 *     watch's per-event sequence: two legitimate `blocked` events for the same
 *     watch must not collapse into one. `enqueued: false` with an id means the
 *     key is already queued, which is fine; `enqueued: false` with no id means
 *     the host dropped it, so we throw and let the watcher retry.
 *  2. **Delivery** runs a chat turn through the Gateway's `chat.send`
 *     (`deliver: true`). This is the step that actually produces a message in
 *     the chat: an injection alone is only context for a turn that may never
 *     start. Preferred path is the trusted in-process seam
 *     `api.runtime.gateway.request`, used only while `isAvailable()` reports an
 *     active Gateway request context; otherwise we spawn
 *     `openclaw gateway call chat.send …` asynchronously. A failure throws so
 *     the watcher's pending-delivery retry engages.
 *  3. `requestHeartbeat` is a best-effort extra. On a host with no configured
 *     heartbeat it does nothing at all, which is why it is no longer the
 *     delivery mechanism; a host without the seam is logged, not passed over.
 *
 * Keys are derived only from durable state (no clock, no randomness), so a
 * retry after a restart produces the same keys and cannot double-post:
 * `herdr:<watchId>:<status>:<notificationSeq ?? 0>` for the injection and the
 * same string plus `:send` for the delivery.
 */
export class OpenClawNotifier implements Notifier {
  readonly #openclawBin: string;
  readonly #deliveryTimeoutMs: number;
  readonly #runCommand: DeliveryCommandRunner;

  constructor(
    private readonly api: HostApi,
    options: OpenClawNotifierOptions = {},
  ) {
    this.#openclawBin = options.openclawBin ?? "openclaw";
    this.#deliveryTimeoutMs = options.deliveryTimeoutMs ?? 60_000;
    this.#runCommand = options.runCommand ?? spawnCommand;
  }

  async notify(watch: WatchRecord, status: SettledStatus, text: string): Promise<void> {
    const seq = (watch as NotifiableWatch).notificationSeq ?? 0;
    const idempotencyKey = `herdr:${watch.id}:${status}:${seq}`;
    const message = [RELAY_HEADER, text].join("\n");

    const injection = await this.api.session.workflow.enqueueNextTurnInjection({
      sessionKey: watch.sessionKey,
      ...(watch.agentId ? { agentId: watch.agentId } : {}),
      text: [CONTEXT_HEADER, text].join("\n"),
      idempotencyKey,
      placement: "append_context",
      ttlMs: 24 * 60 * 60 * 1000,
      metadata: { kind: "herdr-watch", watchId: watch.id, paneId: watch.paneId, status },
    });
    if (injection.enqueued) {
      this.api.logger.info?.(`herdr: queued ${status} for ${watch.paneId} → ${injection.sessionKey} (${injection.id})`);
    } else if (injection.id) {
      // The host answers `enqueued: false` with the existing record's id when
      // this key is already queued (and when our queue is full). Both mean the
      // durable copy is in place, so a retry after a failed delivery must go on
      // to deliver instead of failing here.
      this.api.logger.info?.(`herdr: ${status} for ${watch.paneId} was already queued (${injection.id})`);
    } else {
      // No id: the host rejected or dropped it outright (bad params, unknown
      // session). Throw so the watcher keeps the watch.
      throw new Error(`herdr: host refused the ${status} injection for ${watch.paneId} (key ${idempotencyKey})`);
    }

    await this.#deliver(watch, status, message, `${idempotencyKey}:send`);
    this.#requestHeartbeat(watch, status);
  }

  /** Runs the chat turn that makes the message visible. Throws on failure. */
  async #deliver(watch: WatchRecord, status: SettledStatus, message: string, idempotencyKey: string): Promise<void> {
    const params: Record<string, unknown> = {
      sessionKey: watch.sessionKey,
      ...(watch.agentId ? { agentId: watch.agentId } : {}),
      message,
      deliver: true,
      idempotencyKey,
    };
    const gateway = this.api.runtime?.gateway;
    if (gateway) {
      let inProcess = false;
      try {
        inProcess = await gateway.isAvailable();
      } catch (error) {
        this.api.logger.warn?.(`herdr: in-process Gateway probe failed (${describe(error)}); using the CLI`);
      }
      if (inProcess) {
        await gateway.request(CHAT_SEND_METHOD, params, { timeoutMs: this.#deliveryTimeoutMs });
        this.api.logger.info?.(`herdr: delivered ${status} for ${watch.paneId} in-process (${idempotencyKey})`);
        return;
      }
    }
    const args = [
      "gateway",
      "call",
      CHAT_SEND_METHOD,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(this.#deliveryTimeoutMs),
    ];
    // Kill a shade later than the RPC budget so the CLI can report its own timeout.
    const result = await this.#runCommand(this.#openclawBin, args, { timeoutMs: this.#deliveryTimeoutMs + 5_000 });
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).slice(-500);
      throw new Error(
        `herdr: ${this.#openclawBin} gateway call ${CHAT_SEND_METHOD} ${result.code === null ? "was killed (timeout)" : `exited ${result.code}`} for ${watch.paneId}: ${detail}`,
      );
    }
    this.api.logger.info?.(`herdr: delivered ${status} for ${watch.paneId} via the CLI (${idempotencyKey})`);
  }

  /** Best effort: never fails a delivery that already succeeded. */
  #requestHeartbeat(watch: WatchRecord, status: SettledStatus): void {
    const system = this.api.runtime?.system;
    if (!system?.requestHeartbeat) {
      this.api.logger.warn?.(
        `herdr: no runtime.system.requestHeartbeat on this host; the ${status} turn for ${watch.paneId} relies on chat.send alone`,
      );
      return;
    }
    try {
      system.requestHeartbeat({
        source: "other",
        intent: "event",
        reason: `herdr ${status} ${watch.paneId}`,
        sessionKey: watch.sessionKey,
        ...(watch.agentId ? { agentId: watch.agentId } : {}),
      });
    } catch (error) {
      this.api.logger.warn?.(`herdr: requestHeartbeat failed after delivering ${status}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Asynchronous child process, no shell, arguments passed as argv (never
 * `spawnSync`: the watcher runs on the Gateway's event loop).
 */
function spawnCommand(
  bin: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<DeliveryCommandResult> {
  return new Promise<DeliveryCommandResult>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const capture = (target: "out" | "err") => (chunk: string) => {
      if (target === "out") stdout = (stdout + chunk).slice(-MAX_CAPTURED_OUTPUT);
      else stderr = (stderr + chunk).slice(-MAX_CAPTURED_OUTPUT);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", capture("out"));
    child.stderr?.on("data", capture("err"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        stdout,
        stderr: timedOut ? `${stderr}\nkilled after ${options.timeoutMs}ms` : stderr,
      });
    });
  });
}
