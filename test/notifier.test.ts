import { describe, expect, it } from "vitest";
import type { WatchRecord } from "../src/core/watch-store.js";
import type {
  HostApi,
  HostHeartbeatRunOptions,
  HostHeartbeatRunResult,
  HostNextTurnInjection,
  HostSystemEventOptions,
} from "../src/openclaw/host-api.js";
import { DeliverySkippedError, OpenClawNotifier } from "../src/openclaw/notifier.js";

interface Fake {
  api: HostApi;
  injections: HostNextTurnInjection[];
  runs: HostHeartbeatRunOptions[];
  events: Array<{ text: string; options: HostSystemEventOptions }>;
  logs: string[];
}

function fakeHost(
  options: {
    enqueued?: boolean;
    /** Emulates a dedupe hit: `enqueued: false` carrying the existing id. */
    duplicateId?: string;
    /** `undefined` means the host exposes no heartbeat runtime at all. */
    result?: HostHeartbeatRunResult | "throw";
  } = {},
): Fake {
  const injections: HostNextTurnInjection[] = [];
  const runs: HostHeartbeatRunOptions[] = [];
  const events: Array<{ text: string; options: HostSystemEventOptions }> = [];
  const logs: string[] = [];
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
    ...(options.result === undefined
      ? {}
      : {
          runtime: {
            system: {
              enqueueSystemEvent: (text: string, options: HostSystemEventOptions) => {
                events.push({ text, options });
                return true;
              },
              runHeartbeatOnce: async (opts?: HostHeartbeatRunOptions) => {
                runs.push(opts ?? {});
                if (options.result === "throw") throw new Error("heartbeat runtime exploded");
                return options.result as HostHeartbeatRunResult;
              },
            },
          },
        }),
  };
  return { api, injections, runs, events, logs };
}

const ran: HostHeartbeatRunResult = { status: "ran", durationMs: 1234 };

const watch: WatchRecord = {
  id: "w-1",
  serverId: "local",
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
  it("queues the event in the originating session, keyed by watch, status and sequence", async () => {
    const host = fakeHost({ result: ran });
    const notify = new OpenClawNotifier(host.api);
    await notify.notify({ ...watch, notificationSeq: 3 } as WatchRecord, "blocked", "needs your input");
    await notify.notify({ ...watch, notificationSeq: 4 } as WatchRecord, "blocked", "needs your input again");
    expect(host.injections.map((i) => i.idempotencyKey)).toEqual(["herdr:w-1:blocked:3", "herdr:w-1:blocked:4"]);
    expect(host.injections[0]?.sessionKey).toBe("agent:main:telegram:1");
    expect(host.injections[0]?.agentId).toBe("main");
    expect(host.injections[0]?.text).toContain("[Herdr watch event]");
    expect(host.injections[0]?.text).toContain("needs your input");
  });

  it("falls back to sequence 0 when the watch has none", async () => {
    const host = fakeHost({ result: ran });
    const { notificationSeq: _drop, ...bare } = watch;
    await new OpenClawNotifier(host.api).notify(bare as WatchRecord, "idle", "done");
    expect(host.injections[0]?.idempotencyKey).toBe("herdr:w-1:idle:0");
  });

  it("runs one heartbeat turn in that session and counts `ran` as delivered", async () => {
    const host = fakeHost({ result: ran });
    await new OpenClawNotifier(host.api).notify(watch, "idle", "finished");
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0]).toEqual({
      reason: "wake",
      sessionKey: "agent:main:telegram:1",
      agentId: "main",
      heartbeat: { target: "last" },
    });
    expect(host.logs.some((l) => l.includes("delivered idle for w6:p1"))).toBe(true);
  });

  it("queues a replaceable system event keyed like the injection", async () => {
    const host = fakeHost({ result: ran });
    await new OpenClawNotifier(host.api).notify({ ...watch, notificationSeq: 2 } as WatchRecord, "blocked", "needs input");
    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.options).toEqual({ sessionKey: "agent:main:telegram:1", contextKey: "herdr:w-1:blocked:2", replace: true });
    expect(host.events[0]?.text).toContain("needs input");
  });

  it("honours a configured heartbeat target", async () => {
    const host = fakeHost({ result: ran });
    await new OpenClawNotifier(host.api, { heartbeatTarget: "telegram" }).notify(watch, "idle", "x");
    expect(host.runs[0]?.heartbeat).toEqual({ target: "telegram" });
  });

  it("throws a retryable error when the turn was skipped, carrying retryAtMs", async () => {
    const host = fakeHost({ result: { status: "skipped", reason: "session busy", retryAtMs: 99 } });
    const error = await new OpenClawNotifier(host.api).notify(watch, "idle", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliverySkippedError);
    expect((error as DeliverySkippedError).retryAtMs).toBe(99);
    expect((error as Error).message).toContain("session busy");
  });

  it("throws when the turn failed, so the watcher retries", async () => {
    const host = fakeHost({ result: { status: "failed", reason: "model unavailable" } });
    await expect(new OpenClawNotifier(host.api).notify(watch, "idle", "x")).rejects.toThrow(/model unavailable/u);
  });

  it("throws when the heartbeat runtime itself throws", async () => {
    const host = fakeHost({ result: "throw" });
    await expect(new OpenClawNotifier(host.api).notify(watch, "idle", "x")).rejects.toThrow(/exploded/u);
  });

  it("throws, after queueing, when the host has no heartbeat runtime", async () => {
    const host = fakeHost();
    await expect(new OpenClawNotifier(host.api).notify(watch, "idle", "x")).rejects.toThrow(/runHeartbeatOnce/u);
    expect(host.injections).toHaveLength(1);
  });

  it("still runs the turn when the key was already queued, so a retry completes", async () => {
    const host = fakeHost({ enqueued: false, duplicateId: "inj-old", result: ran });
    await new OpenClawNotifier(host.api).notify(watch, "idle", "x");
    expect(host.runs).toHaveLength(1);
    expect(host.logs.some((l) => l.includes("already queued"))).toBe(true);
  });

  it("throws when the host dropped the injection outright, and runs nothing", async () => {
    const host = fakeHost({ enqueued: false, result: ran });
    await expect(new OpenClawNotifier(host.api).notify(watch, "idle", "x")).rejects.toThrow(/refused/u);
    expect(host.runs).toHaveLength(0);
  });
});
