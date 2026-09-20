import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LineDecoder, encodeRequest } from "./framing.js";
import type {
  AgentInfo,
  AgentPromptWaitOptions,
  AgentStatus,
  HerdrError,
  PaneReadResult,
  PingResult,
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
  requestTimeoutMs?: number;
}

export interface Subscription {
  close(): void;
  /** Resolves when the server closes the stream or the socket errors. */
  readonly closed: Promise<void>;
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
 * Minimal client for Herdr's Unix-socket API.
 *
 * Herdr answers exactly one request per connection and then closes it, so
 * `request()` opens a fresh socket every time. `subscribe()` is the one
 * long-lived connection: the server acknowledges and then streams events
 * until either side closes.
 */
export class HerdrClient {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = nextId();
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const decoder = new LineDecoder();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new HerdrTransportError(`Herdr ${method} timed out after ${this.requestTimeoutMs}ms`))),
        this.requestTimeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(encodeRequest(id, method, params)));
      socket.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) {
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
    });
  }

  subscribe(
    subscriptions: SubscriptionSpec[],
    onEvent: (event: SubscriptionEvent) => void,
    onError?: (error: Error) => void,
  ): Subscription {
    const socket = net.createConnection(this.socketPath);
    const decoder = new LineDecoder();
    let acknowledged = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encodeRequest(nextId(), "events.subscribe", { subscriptions })));
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
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
            onError?.(new HerdrRequestError(outcome.error));
            socket.destroy();
          }
          continue;
        }
        if (isRecord(parsed) && typeof parsed.event === "string" && isRecord(parsed.data)) {
          onEvent({ event: parsed.event, data: parsed.data });
        }
      }
    });
    socket.on("error", (cause) => onError?.(new HerdrTransportError(`Herdr subscription error: ${cause.message}`, { cause })));
    socket.on("close", () => resolveClosed());
    return {
      close: () => socket.destroy(),
      closed,
    };
  }

  // ---- Typed helpers for the methods the plugin actually uses ----

  ping(): Promise<PingResult> {
    return this.request<PingResult>("ping");
  }

  async listAgents(): Promise<AgentInfo[]> {
    const result = await this.request<{ agents?: AgentInfo[] }>("agent.list");
    return Array.isArray(result.agents) ? result.agents : [];
  }

  async getAgent(target: string): Promise<AgentInfo> {
    const result = await this.request<{ agent?: AgentInfo } & Partial<AgentInfo>>("agent.get", { target });
    return (result.agent ?? result) as AgentInfo;
  }

  async readAgent(target: string, options: { source?: ReadSource; lines?: number } = {}): Promise<PaneReadResult> {
    const result = await this.request<{ read: PaneReadResult }>("agent.read", {
      target,
      source: options.source ?? "recent",
      ...(options.lines !== undefined ? { lines: options.lines } : {}),
      format: "text",
      strip_ansi: true,
    });
    return result.read;
  }

  prompt(target: string, text: string, wait?: AgentPromptWaitOptions): Promise<unknown> {
    return this.request("agent.prompt", { target, text, ...(wait ? { wait } : {}) });
  }

  waitFor(target: string, until: AgentStatus[], timeoutMs?: number): Promise<unknown> {
    return this.request("agent.wait", {
      target,
      until,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    });
  }

  async explain(target: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("agent.explain", { target });
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
