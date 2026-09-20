/**
 * The slice of OpenClaw's plugin API this plugin touches. Declared locally so
 * the code documents its own host contract and so tests can pass a fake.
 * The real object comes from `definePluginEntry` in `openclaw/plugin-sdk`.
 */
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

export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface HostTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<HostToolResult>;
}

export interface HostServiceContext {
  stateDir: string;
  logger: HostLogger;
}

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
      enqueueNextTurnInjection: (injection: {
        sessionKey: string;
        agentId?: string;
        text: string;
        idempotencyKey?: string;
        placement?: "append_context" | "prepend_context";
        ttlMs?: number;
        metadata?: unknown;
      }) => Promise<{ enqueued: boolean; id: string; sessionKey: string }>;
    };
  };
  runtime?: {
    system?: {
      requestHeartbeat?: (opts: {
        source: string;
        intent: string;
        reason?: string;
        sessionKey?: string;
        agentId?: string;
      }) => void;
    };
  };
}
