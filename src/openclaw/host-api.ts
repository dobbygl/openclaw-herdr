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

/** Wake request for `runtime.system.requestHeartbeat`, derived from the host. */
export type HostHeartbeatRequest = Parameters<
  NonNullable<OpenClawPluginApi["runtime"]["system"]["requestHeartbeat"]>
>[0];

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
   * Optional on purpose: older hosts and test fakes may not expose these, and
   * the notifier has to keep working (loudly) without them - it falls back to
   * the `openclaw` CLI when the in-process Gateway seam is unavailable.
   */
  runtime?: {
    system?: {
      requestHeartbeat?: (opts: HostHeartbeatRequest) => void;
    };
    /** Trusted in-process Gateway dispatch; `isAvailable()` gates `request()`. */
    gateway?: HostGateway;
  };
}

/** Exactly the two members we use, so a fake is two functions. */
export type HostGateway = Pick<OpenClawPluginApi["runtime"]["gateway"], "isAvailable" | "request">;

type Assert<T extends true> = T;

/** Compile-time proof that the installed SDK still satisfies `HostApi`. */
export type SdkSatisfiesHostApi = Assert<OpenClawPluginApi extends HostApi ? true : false>;

/** Compile-time proof that a `HostTool` is what the SDK's `registerTool` accepts. */
export type HostToolIsSdkTool = Assert<
  ((ctx: HostToolContext) => HostTool) extends Parameters<OpenClawPluginApi["registerTool"]>[0] ? true : false
>;
