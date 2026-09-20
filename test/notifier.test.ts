import { describe, expect, it } from "vitest";
import type { WatchRecord } from "../src/core/watch-store.js";
import type { HostApi, HostHeartbeatRequest, HostNextTurnInjection } from "../src/openclaw/host-api.js";
import { OpenClawNotifier, type DeliveryCommandRunner } from "../src/openclaw/notifier.js";

interface GatewayCall {
  method: string;
  params: Record<string, unknown> | undefined;
  timeoutMs: number | undefined;
}

interface CommandCall {
  bin: string;
  args: readonly string[];
  timeoutMs: number;
}

interface Fake {
  api: HostApi;
  injections: HostNextTurnInjection[];
  heartbeats: HostHeartbeatRequest[];
  gatewayCalls: GatewayCall[];
  commands: CommandCall[];
  logs: string[];
  runCommand: DeliveryCommandRunner;
}

function fakeHost(
  options: {
    enqueued?: boolean;
    /** Emulates a dedupe hit: `enqueued: false` carrying the existing id. */
    duplicateId?: string;
    heartbeat?: boolean;
    /** `undefined` means the host exposes no in-process Gateway seam at all. */
    gatewayAvailable?: boolean;
    gatewayThrows?: boolean;
    exitCode?: number | null;
  } = {},
): Fake {
  const injections: HostNextTurnInjection[] = [];
  const heartbeats: HostHeartbeatRequest[] = [];
  const gatewayCalls: GatewayCall[] = [];
  const commands: CommandCall[] = [];
  const logs: string[] = [];
  const runCommand: DeliveryCommandRunner = async (bin, args, opts) => {
    commands.push({ bin, args, timeoutMs: opts.timeoutMs });
    const code = options.exitCode === undefined ? 0 : options.exitCode;
    return { code, stdout: code === 0 ? '{"status":"started"}' : "", stderr: code === 0 ? "" : "gateway unreachable" };
  };
  const api: HostApi = {
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    registerCommand: () => {},
    registerTool: () => {},
    registerService: () => {},
    session: {
      workflow: {
        enqueueNextTurnInjection: async (injection) => {
          injections.push(injection);
          const enqueued = options.enqueued ?? true;
          const id = enqueued ? `inj-${injections.length}` : (options.duplicateId ?? "");
          return { enqueued, id, sessionKey: injection.sessionKey };
        },
      },
    },
    runtime: {
      ...(options.heartbeat === false
        ? {}
        : { system: { requestHeartbeat: (opts: HostHeartbeatRequest) => void heartbeats.push(opts) } }),
      ...(options.gatewayAvailable === undefined
        ? {}
        : {
            gateway: {
              isAvailable: async () => options.gatewayAvailable === true,
              request: async <T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
                gatewayCalls.push({ method, params, timeoutMs: opts?.timeoutMs });
                if (options.gatewayThrows) throw new Error("gateway refused");
                return { status: "started" } as T;
              },
            },
          }),
    },
  };
  return { api, injections, heartbeats, gatewayCalls, commands, logs, runCommand };
}

function notifier(host: Fake, deliveryTimeoutMs = 60_000): OpenClawNotifier {
  return new OpenClawNotifier(host.api, { openclawBin: "openclaw-test", deliveryTimeoutMs, runCommand: host.runCommand });
}

const watch: WatchRecord = {
  id: "w-1",
  paneId: "w6:p1",
  terminalId: "term_1",
  agentLabel: "claude",
  sessionKey: "agent:main:telegram:1",
  agentId: "main",
  promptPreview: "run the tests",
  createdAt: new Date(0).toISOString(),
  deadlineAt: new Date(60_000).toISOString(),
  seqAtStart: 4,
  lastStatus: "working",
  sawWorking: true,
  notificationSeq: 0,
};

describe("OpenClawNotifier", () => {
  it("keys the injection by watch, status and event sequence", async () => {
    const host = fakeHost();
    const notify = notifier(host);
    await notify.notify({ ...watch, notificationSeq: 3 } as WatchRecord, "blocked", "needs your input");
    await notify.notify({ ...watch, notificationSeq: 4 } as WatchRecord, "blocked", "needs your input again");
    expect(host.injections.map((injection) => injection.idempotencyKey)).toEqual([
      "herdr:w-1:blocked:3",
      "herdr:w-1:blocked:4",
    ]);
    expect(host.injections[0]?.sessionKey).toBe("agent:main:telegram:1");
    expect(host.injections[0]?.agentId).toBe("main");
    expect(host.injections[0]?.placement).toBe("append_context");
    expect(host.injections[0]?.text).toContain("needs your input");
    expect(host.injections[0]?.text).toContain("queued copy");
  });

  it("falls back to sequence 0 when the watch has none", async () => {
    const host = fakeHost();
    await notifier(host).notify(watch, "idle", "finished");
    expect(host.injections[0]?.idempotencyKey).toBe("herdr:w-1:idle:0");
  });

  it("delivers through the in-process Gateway when one is active", async () => {
    const host = fakeHost({ gatewayAvailable: true });
    await notifier(host, 30_000).notify(watch, "done", "finished");
    expect(host.commands).toEqual([]);
    expect(host.gatewayCalls).toHaveLength(1);
    expect(host.gatewayCalls[0]?.method).toBe("chat.send");
    expect(host.gatewayCalls[0]?.timeoutMs).toBe(30_000);
    expect(host.gatewayCalls[0]?.params).toMatchObject({
      sessionKey: "agent:main:telegram:1",
      agentId: "main",
      deliver: true,
      idempotencyKey: "herdr:w-1:done:0:send",
    });
    expect(String(host.gatewayCalls[0]?.params?.message)).toContain("finished");
  });

  it("spawns the openclaw CLI when no Gateway request context is active", async () => {
    const host = fakeHost({ gatewayAvailable: false });
    await notifier(host, 20_000).notify(watch, "idle", "finished");
    expect(host.gatewayCalls).toEqual([]);
    expect(host.commands).toHaveLength(1);
    const call = host.commands[0];
    expect(call?.bin).toBe("openclaw-test");
    expect(call?.args.slice(0, 4)).toEqual(["gateway", "call", "chat.send", "--params"]);
    expect(call?.args).toContain("--json");
    expect(call?.args[call.args.length - 1]).toBe("20000");
    expect(call && call.timeoutMs).toBe(25_000);
    const params = JSON.parse(String(call?.args[4])) as Record<string, unknown>;
    expect(params).toMatchObject({
      sessionKey: "agent:main:telegram:1",
      agentId: "main",
      deliver: true,
      idempotencyKey: "herdr:w-1:idle:0:send",
    });
    expect(String(params.message)).toContain("Relay the following to the user as-is");
  });

  it("uses the CLI when the host exposes no Gateway seam", async () => {
    const host = fakeHost();
    await notifier(host).notify(watch, "idle", "finished");
    expect(host.commands).toHaveLength(1);
  });

  it("throws when the CLI delivery fails, so the watcher retries", async () => {
    const host = fakeHost({ exitCode: 3 });
    await expect(notifier(host).notify(watch, "idle", "finished")).rejects.toThrow(/exited 3/u);
    expect(host.heartbeats).toHaveLength(0);
  });

  it("throws when the in-process delivery fails", async () => {
    const host = fakeHost({ gatewayAvailable: true, gatewayThrows: true });
    await expect(notifier(host).notify(watch, "idle", "finished")).rejects.toThrow(/gateway refused/u);
  });

  it("always asks for a heartbeat after delivering", async () => {
    const host = fakeHost();
    await notifier(host).notify(watch, "done", "finished");
    expect(host.heartbeats).toHaveLength(1);
    expect(host.heartbeats[0]?.source).toBe("other");
    expect(host.heartbeats[0]?.intent).toBe("event");
    expect(host.heartbeats[0]?.sessionKey).toBe("agent:main:telegram:1");
    expect(host.heartbeats[0]?.agentId).toBe("main");
  });

  it("warns when the host has no heartbeat seam", async () => {
    const host = fakeHost({ heartbeat: false });
    await notifier(host).notify(watch, "done", "finished");
    expect(host.commands).toHaveLength(1);
    expect(host.logs.some((line) => line.startsWith("warn:") && line.includes("requestHeartbeat"))).toBe(true);
  });

  it("still delivers when the key was already queued, so a retry completes", async () => {
    const host = fakeHost({ enqueued: false, duplicateId: "inj-existing" });
    await notifier(host).notify(watch, "idle", "finished");
    expect(host.commands).toHaveLength(1);
    expect(host.heartbeats).toHaveLength(1);
    expect(host.logs.some((line) => line.includes("already queued"))).toBe(true);
  });

  it("throws when the host dropped the injection outright, and delivers nothing", async () => {
    const host = fakeHost({ enqueued: false });
    await expect(notifier(host).notify(watch, "idle", "finished")).rejects.toThrow(/refused/u);
    expect(host.commands).toEqual([]);
    expect(host.gatewayCalls).toEqual([]);
    expect(host.heartbeats).toHaveLength(0);
  });
});
