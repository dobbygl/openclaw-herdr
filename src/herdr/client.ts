import os from "node:os";
import path from "node:path";
import { type ConnectionFactory, type DuplexLike, createUnixSocketFactory } from "./connection.js";
import { LineDecoder, LineTooLongError, encodeRequest } from "./framing.js";
import type {
  AgentInfo,
  AgentPromptWaitOptions,
  AgentStatus,
  HerdrError,
  PaneInfo,
  PaneProcessInfo,
  PaneReadResult,
  PingResult,
  TabInfo,
  ReadSource,
  SubscriptionEvent,
  SubscriptionSpec,
} from "./types.js";

export class HerdrRequestError extends Error {
  readonly code: string;
  constructor(error: HerdrError) {
    super(error.message);
    this.name = "HerdrRequestError";
    this.code = error.code;
  }
}

export class HerdrTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HerdrTransportError";
  }
}

export interface HerdrClientOptions {
  socketPath?: string;
  /**
   * Alternative transport. When given, connections come from this factory
   * instead of a local Unix socket (see `createSshConnectionFactory` for the
   * remote case) and `socketPath` is descriptive only - it is still what
   * `client.socketPath` reports, so pass the remote path when there is one.
   */
  connect?: ConnectionFactory;
  /** Transport timeout for a plain request. Server-side waits get their own budget. */
  requestTimeoutMs?: number;
  /** Added on top of a server-side `timeout_ms` before the transport gives up. */
  waitGraceMs?: number;
  /** Ceiling for one JSON line from the server; see `LineDecoder`. */
  maxLineLength?: number;
  /** How long `Subscription.ready` waits for `subscription_started`. */
  subscribeAckTimeoutMs?: number;
}

export interface HerdrRequestOptions {
  /**
   * Overrides the transport timeout for this one request. Use `0` (or a
   * non-finite value) for no transport timeout at all.
   */
  requestTimeoutMs?: number;
}

export interface SubscribeOptions {
  /** Overrides `subscribeAckTimeoutMs` for this subscription. `0` disables it. */
  ackTimeoutMs?: number;
}

export interface Subscription {
  close(): void;
  /** Resolves when the server closes the stream or the socket errors. */
  readonly closed: Promise<void>;
  /**
   * Resolves on the server's `subscription_started` ack and rejects on an error
   * ack, a socket error, an early close, or an ack timeout. On timeout the
   * socket is destroyed, so `closed` fires too and callers can reconnect.
   */
  readonly ready: Promise<void>;
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_SOCKET_PATH ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `oc-herdr-${process.pid}-${requestCounter}`;
}

/**
 * Minimal client for Herdr's socket API.
 *
 * Herdr answers exactly one request per connection and then closes it, so
 * `request()` opens a fresh connection every time. `subscribe()` is the one
 * long-lived connection: the server acknowledges and then streams events
 * until either side closes.
 *
 * The connection itself comes from a `ConnectionFactory`, which defaults to a
 * local Unix socket at `socketPath`. Nothing below this line cares whether the
 * bytes travel over a socket or over an `ssh` child's stdio.
 */
export class HerdrClient {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;
  readonly waitGraceMs: number;
  readonly maxLineLength: number | undefined;
  readonly subscribeAckTimeoutMs: number;
  readonly #connect: ConnectionFactory;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.waitGraceMs = options.waitGraceMs ?? 2_000;
    this.maxLineLength = options.maxLineLength;
    this.subscribeAckTimeoutMs = options.subscribeAckTimeoutMs ?? 5_000;
    this.#connect = options.connect ?? createUnixSocketFactory(this.socketPath);
  }

  async request<T = unknown>(method: string, params: unknown = {}, options: HerdrRequestOptions = {}): Promise<T> {
    const id = nextId();
    const timeoutMs = options.requestTimeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let socket: DuplexLike;
      try {
        socket = this.#connect();
      } catch (cause) {
        reject(new HerdrTransportError(`Herdr transport for ${method} could not be opened: ${causeMessage(cause)}`, { cause }));
        return;
      }
      const decoder = this.#decoder();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        fn();
      };
      // An unbounded server-side wait has no transport timeout: only the socket
      // closing (or the caller) can end it.
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(
              () => finish(() => reject(new HerdrTransportError(`Herdr ${method} timed out after ${timeoutMs}ms`))),
              timeoutMs,
            )
          : undefined;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (cause) {
          finish(() => reject(framingError(method, cause)));
          return;
        }
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (cause) {
            finish(() => reject(new HerdrTransportError(`Herdr sent a non-JSON line for ${method}`, { cause })));
            return;
          }
          finish(() => {
            const outcome = interpretResponse(parsed);
            if (outcome.ok) resolve(outcome.result as T);
            else reject(new HerdrRequestError(outcome.error));
          });
          return;
        }
      });
      socket.on("error", (cause) =>
        finish(() => reject(new HerdrTransportError(`Herdr socket error for ${method}: ${cause.message}`, { cause }))),
      );
      socket.on("close", () =>
        finish(() => reject(new HerdrTransportError(`Herdr closed the connection before answering ${method}`))),
      );
      // No `connect` event: a Unix socket buffers this write until it is
      // connected, and an ssh child's stdin is writable from the start.
      socket.write(encodeRequest(id, method, params));
    });
  }

  subscribe(
    subscriptions: SubscriptionSpec[],
    onEvent: (event: SubscriptionEvent) => void,
    onError?: (error: Error) => void,
    options: SubscribeOptions = {},
  ): Subscription {
    const ackTimeoutMs = options.ackTimeoutMs ?? this.subscribeAckTimeoutMs;
    const decoder = this.#decoder();
    let acknowledged = false;
    let readySettled = false;

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Callers may ignore `ready` (the watcher only uses `onError`/`closed`).
    // Attaching a sink here keeps Node from reporting an unhandled rejection
    // while still handing the real, rejecting promise to callers.
    void ready.catch(() => {});

    let ackTimer: NodeJS.Timeout | undefined;
    const clearAckTimer = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = undefined;
    };
    const settleReady = (error?: Error) => {
      clearAckTimer();
      if (readySettled) return;
      readySettled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };
    const fail = (error: Error) => {
      settleReady(error);
      onError?.(error);
    };

    // A factory may reject the transport outright (a bad ssh target, an unsafe
    // remote path). `subscribe()` is not promise-wrapped, so that failure is
    // reported through the same `ready`/`closed`/`onError` contract instead of
    // throwing at the caller.
    let socket: DuplexLike;
    try {
      socket = this.#connect();
    } catch (cause) {
      const error = new HerdrTransportError(
        `Herdr subscription transport could not be opened: ${causeMessage(cause)}`,
        { cause },
      );
      fail(error);
      resolveClosed();
      return { close: () => {}, closed, ready };
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (cause) {
        fail(framingError("events.subscribe", cause));
        socket.destroy();
        return;
      }
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!acknowledged) {
          acknowledged = true;
          const outcome = interpretResponse(parsed);
          if (!outcome.ok) {
            fail(new HerdrRequestError(outcome.error));
            socket.destroy();
            continue;
          }
          const type = isRecord(outcome.result) ? outcome.result.type : undefined;
          if (typeof type === "string" && type !== "subscription_started") {
            fail(new HerdrTransportError(`Herdr answered events.subscribe with "${type}" instead of subscription_started`));
            socket.destroy();
            continue;
          }
          settleReady();
          continue;
        }
        if (isRecord(parsed) && typeof parsed.event === "string" && isRecord(parsed.data)) {
          onEvent({ event: parsed.event, data: parsed.data });
        }
      }
    });
    socket.on("error", (cause) =>
      fail(new HerdrTransportError(`Herdr subscription error: ${cause.message}`, { cause })),
    );
    socket.on("close", () => {
      clearAckTimer();
      settleReady(new HerdrTransportError("Herdr closed the subscription before acknowledging it"));
      resolveClosed();
    });

    socket.write(encodeRequest(nextId(), "events.subscribe", { subscriptions }));

    if (ackTimeoutMs > 0 && Number.isFinite(ackTimeoutMs)) {
      ackTimer = setTimeout(() => {
        fail(new HerdrTransportError(`Herdr did not acknowledge the subscription within ${ackTimeoutMs}ms`));
        socket.destroy();
      }, ackTimeoutMs);
    }

    return {
      close: () => socket.destroy(),
      closed,
      ready,
    };
  }

  // ---- Typed helpers for the methods the plugin actually uses ----

  async ping(): Promise<PingResult> {
    const result = await this.request<unknown>("ping");
    if (!isRecord(result) || typeof result.version !== "string" || typeof result.protocol !== "number") {
      throw new HerdrTransportError("Herdr ping did not return a version and protocol");
    }
    return result as unknown as PingResult;
  }

  /** Malformed rows are dropped rather than faked: a pane we cannot address is not a target. */
  async listAgents(): Promise<AgentInfo[]> {
    const result = await this.request<unknown>("agent.list");
    const agents = isRecord(result) && Array.isArray(result.agents) ? result.agents : [];
    const normalized: AgentInfo[] = [];
    for (const entry of agents) {
      const agent = normalizeAgentInfo(entry);
      if (agent) normalized.push(agent);
    }
    return normalized;
  }

  /** Every pane of one workspace (or all), including plain shells. */
  async listPanes(workspaceId?: string): Promise<PaneInfo[]> {
    const result = await this.request<unknown>("pane.list", workspaceId ? { workspace_id: workspaceId } : {});
    const panes = isRecord(result) && Array.isArray(result.panes) ? result.panes : [];
    return panes.filter(
      (pane): pane is PaneInfo =>
        isRecord(pane) && typeof pane.pane_id === "string" && typeof pane.workspace_id === "string" && typeof pane.tab_id === "string",
    );
  }

  /**
   * Every tab of one workspace (or all). Malformed rows are dropped. A server
   * without `tab.list` answers with an ordinary Herdr error, which is thrown
   * as a {@link HerdrRequestError} like any other refusal.
   */
  async listTabs(workspaceId?: string): Promise<TabInfo[]> {
    const result = await this.request<unknown>("tab.list", workspaceId ? { workspace_id: workspaceId } : {});
    const tabs = isRecord(result) && Array.isArray(result.tabs) ? result.tabs : [];
    return tabs.filter(
      (tab): tab is TabInfo =>
        isRecord(tab) && typeof tab.tab_id === "string" && typeof tab.workspace_id === "string" && typeof tab.label === "string",
    );
  }

  /** New tab (with one shell pane) in a workspace; returns the new pane. */
  async createTab(options: { workspaceId?: string; label?: string; cwd?: string; focus?: boolean }): Promise<PaneInfo> {
    const result = await this.request<unknown>("tab.create", {
      ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      focus: options.focus ?? false,
    });
    const pane = isRecord(result) ? result.root_pane : undefined;
    if (!isRecord(pane) || typeof pane.pane_id !== "string") {
      throw new HerdrTransportError("Herdr tab.create returned no root pane");
    }
    return pane as unknown as PaneInfo;
  }

  /** Foreground processes of a pane, as `pane.process_info` reports them. */
  async paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
    const result = await this.request<unknown>("pane.process_info", { pane_id: paneId });
    const info = isRecord(result) ? result.process_info : undefined;
    if (!isRecord(info)) throw new HerdrTransportError(`Herdr pane.process_info returned nothing for ${paneId}`);
    const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
    return {
      pane_id: paneId,
      shell_pid: typeof info.shell_pid === "number" ? info.shell_pid : null,
      foreground_processes: processes
        .filter((proc): proc is Record<string, unknown> => isRecord(proc) && typeof proc.pid === "number")
        .map((proc) => ({ pid: proc.pid as number, name: typeof proc.name === "string" ? proc.name : "" })),
    };
  }

  /**
   * Resolves once the pane's only foreground process is its own shell, i.e.
   * the state `agent.start` requires. A pane fresh from `tab.create` is not
   * there yet (the shell is still starting and drawing its prompt), which
   * Herdr reports as `agent_pane_busy`.
   */
  async waitForIdleShell(paneId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    const interval = options.intervalMs ?? 250;
    for (;;) {
      try {
        const info = await this.paneProcessInfo(paneId);
        const [only, ...rest] = info.foreground_processes;
        if (only && rest.length === 0 && info.shell_pid !== null && only.pid === info.shell_pid) return true;
      } catch {
        // A transient read failure is not a verdict; keep polling until the deadline.
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * Starts a supported agent in an existing shell pane and waits until Herdr
   * sees it ready. The transport budget covers the server-side startup wait.
   * `agent_pane_busy` right after the pane was created is retried briefly:
   * Herdr checks the prompt, which appears a moment after the shell process.
   */
  async startAgent(options: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
    /** Retries when Herdr answers `agent_pane_busy` (shell not at its prompt yet). */
    busyRetries?: number;
    busyRetryDelayMs?: number;
  }): Promise<AgentInfo> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const params = {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
      timeout_ms: timeoutMs,
      ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
    };
    const busyRetries = options.busyRetries ?? 8;
    let result: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.request<unknown>("agent.start", params, { requestTimeoutMs: timeoutMs + 10_000 });
        break;
      } catch (error) {
        if (error instanceof HerdrRequestError && error.code === "agent_pane_busy" && attempt < busyRetries) {
          await new Promise((resolve) => setTimeout(resolve, options.busyRetryDelayMs ?? 500));
          continue;
        }
        throw error;
      }
    }
    const payload = isRecord(result) && isRecord(result.agent) ? result.agent : result;
    const agent = normalizeAgentInfo(payload);
    if (!agent) throw new HerdrTransportError(`Herdr agent.start returned no usable agent for ${options.paneId}`);
    return agent;
  }

  async getAgent(target: string): Promise<AgentInfo> {
    const result = await this.request<unknown>("agent.get", { target });
    const payload = isRecord(result) && isRecord(result.agent) ? result.agent : result;
    const agent = normalizeAgentInfo(payload);
    if (!agent) throw new HerdrTransportError(`Herdr agent.get returned no usable agent for ${target}`);
    return agent;
  }

  async readAgent(target: string, options: { source?: ReadSource; lines?: number } = {}): Promise<PaneReadResult> {
    const result = await this.request<unknown>("agent.read", {
      target,
      source: options.source ?? "recent",
      ...(options.lines !== undefined ? { lines: options.lines } : {}),
      format: "text",
      strip_ansi: true,
    });
    const read = isRecord(result) ? result.read : undefined;
    if (!isRecord(read) || typeof read.text !== "string") {
      throw new HerdrTransportError(`Herdr agent.read returned no text for ${target}`);
    }
    return read as unknown as PaneReadResult;
  }

  /**
   * `wait` makes the server hold the connection for up to `wait.timeout_ms`, so
   * the transport budget is stretched to cover it; without a `timeout_ms` the
   * wait is unbounded and gets no transport timeout at all.
   */
  prompt(
    target: string,
    text: string,
    wait?: AgentPromptWaitOptions,
    options: HerdrRequestOptions = {},
  ): Promise<unknown> {
    return this.request(
      "agent.prompt",
      { target, text, ...(wait ? { wait } : {}) },
      wait ? this.#waitBudget(wait.timeout_ms, options) : options,
    );
  }

  /** Server-owned wait; same budget rule as `prompt` with `wait`. */
  waitFor(
    target: string,
    until: AgentStatus[],
    timeoutMs?: number,
    options: HerdrRequestOptions = {},
  ): Promise<unknown> {
    return this.request(
      "agent.wait",
      { target, until, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) },
      this.#waitBudget(timeoutMs, options),
    );
  }

  async explain(target: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("agent.explain", { target });
  }

  #decoder(): LineDecoder {
    return new LineDecoder(this.maxLineLength !== undefined ? { maxLineLength: this.maxLineLength } : {});
  }

  #waitBudget(timeoutMs: number | null | undefined, options: HerdrRequestOptions): HerdrRequestOptions {
    if (options.requestTimeoutMs !== undefined) return { requestTimeoutMs: options.requestTimeoutMs };
    if (timeoutMs === undefined || timeoutMs === null) return { requestTimeoutMs: 0 };
    return { requestTimeoutMs: Math.max(this.requestTimeoutMs, timeoutMs + this.waitGraceMs) };
  }
}

type ResponseOutcome = { ok: true; result: unknown } | { ok: false; error: HerdrError };

function interpretResponse(parsed: unknown): ResponseOutcome {
  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "malformed_response", message: "Herdr response was not an object" } };
  }
  if (isRecord(parsed.error)) {
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "unknown";
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown Herdr error";
    return { ok: false, error: { code, message } };
  }
  if ("result" in parsed) return { ok: true, result: parsed.result };
  return { ok: false, error: { code: "malformed_response", message: "Herdr response had neither result nor error" } };
}

/**
 * True when Herdr refused `method` because it does not know it: an older
 * server answers `invalid_request` with serde's "unknown variant `<method>`".
 * Any other refusal (permission, internal error, bad params) is a real
 * failure and must not be read as "not supported".
 */
export function isUnknownMethodError(error: unknown, method: string): boolean {
  return (
    error instanceof HerdrRequestError &&
    error.code === "invalid_request" &&
    error.message.includes(`unknown variant \`${method}\``)
  );
}

export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : String(cause);
}

function framingError(method: string, cause: unknown): HerdrTransportError {
  if (cause instanceof LineTooLongError) {
    return new HerdrTransportError(`Herdr sent an oversized line for ${method}: ${cause.message}`, { cause });
  }
  return new HerdrTransportError(`Herdr framing failed for ${method}: ${(cause as Error).message}`, { cause });
}

const AGENT_STATUSES: readonly string[] = ["idle", "working", "blocked", "done", "unknown"];

/** Anything Herdr does not classify is `unknown`; never treat it as finished. */
export function normalizeAgentStatus(value: unknown): AgentStatus {
  return typeof value === "string" && AGENT_STATUSES.includes(value) ? (value as AgentStatus) : "unknown";
}

/**
 * Boundary check for one `agents[]` row. Unknown extra fields are kept as-is
 * (Herdr's compatibility rule), but a row we could not address later - no
 * string `pane_id`/`terminal_id` - is rejected here instead of downstream.
 */
export function normalizeAgentInfo(value: unknown): AgentInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.pane_id !== "string" || value.pane_id.length === 0) return undefined;
  if (typeof value.terminal_id !== "string" || value.terminal_id.length === 0) return undefined;
  return { ...value, agent_status: normalizeAgentStatus(value.agent_status) } as unknown as AgentInfo;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
