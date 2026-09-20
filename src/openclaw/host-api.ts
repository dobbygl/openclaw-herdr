/**
 * The slice of OpenClaw's plugin API this plugin touches.
 *
 * It stays hand-written and narrow so tests can build a fake in a few lines,
 * but every member is checked against the installed SDK: `SdkSatisfiesHostApi`
 * below fails `npm run typecheck` if the real `OpenClawPluginApi` stops being
 * assignable to `HostApi`, and the shapes the host chooses (heartbeat request,
 * next-turn injection, tool parameters/results) are imported rather than
 * re-described. That is what lets `src/index.ts` pass `api` with no cast.
 */
import type { TSchema } from "typebox";
import type {
  OpenClawPluginApi,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
} from "openclaw/plugin-sdk/plugin-entry";

/** Host logger. Every method is optional here so fakes can pass `{}`. */
export interface HostLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface HostCommandContext {
  args?: string;
  commandBody: string;
  sessionKey?: string;
  agentId?: string;
  channel: string;
  isAuthorizedSender: boolean;
}

export interface HostCommandResult {
  text?: string;
  continueAgent?: boolean;
}

export interface HostToolContext {
  sessionKey?: string;
  agentId?: string;
}

/**
 * Mirrors the SDK's `AgentToolResult`: `details` is part of the contract, so it
 * is required here too (pass `undefined` when there is nothing structured).
 */
export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

/** Structurally an SDK `AnyAgentTool`; `parameters` must be a TypeBox schema. */
export interface HostTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<HostToolResult>;
}

export interface HostServiceContext {
  stateDir: string;
  logger: HostLogger;
}

/** Options and result of `runtime.system.runHeartbeatOnce`, derived from the host. */
export type HostHeartbeatRunOptions = NonNullable<
  Parameters<OpenClawPluginApi["runtime"]["system"]["runHeartbeatOnce"]>[0]
>;
export type HostHeartbeatRunResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["system"]["runHeartbeatOnce"]>>;

export type HostNextTurnInjection = PluginNextTurnInjection;
export type HostNextTurnInjectionResult = PluginNextTurnInjectionEnqueueResult;

export interface HostApi {
  pluginConfig?: Record<string, unknown>;
  logger: HostLogger;
  registerCommand: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    agentPromptGuidance?: readonly string[];
    handler: (ctx: HostCommandContext) => Promise<HostCommandResult> | HostCommandResult;
  }) => void;
  registerTool: (factory: (ctx: HostToolContext) => HostTool, opts?: { name?: string; optional?: boolean }) => void;
  registerService: (service: {
    id: string;
    start: (ctx: HostServiceContext) => void | Promise<void>;
    stop?: (ctx: HostServiceContext) => void | Promise<void>;
  }) => void;
  session: {
    workflow: {
      enqueueNextTurnInjection: (injection: HostNextTurnInjection) => Promise<HostNextTurnInjectionResult>;
    };
  };
  /**
   * Optional on purpose: older hosts and test fakes may not expose it, and the
   * notifier must fail loudly (and retry) rather than crash without it.
   */
  runtime?: {
    system?: {
      runHeartbeatOnce?: (opts?: HostHeartbeatRunOptions) => Promise<HostHeartbeatRunResult>;
    };
  };
}

type Assert<T extends true> = T;

/** Compile-time proof that the installed SDK still satisfies `HostApi`. */
export type SdkSatisfiesHostApi = Assert<OpenClawPluginApi extends HostApi ? true : false>;

/** Compile-time proof that a `HostTool` is what the SDK's `registerTool` accepts. */
export type HostToolIsSdkTool = Assert<
  ((ctx: HostToolContext) => HostTool) extends Parameters<OpenClawPluginApi["registerTool"]>[0] ? true : false
>;
