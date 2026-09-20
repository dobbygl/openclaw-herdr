import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Subscription } from "../src/herdr/client.js";
import type { AgentInfo, PaneReadResult, SubscriptionEvent, SubscriptionSpec } from "../src/herdr/types.js";
import { WatchStore, type WatchRecord } from "../src/core/watch-store.js";
import { HerdrWatcher, type Notifier, type SettledStatus, type WatcherClient } from "../src/core/watcher.js";

interface FakeSubscription {
  id: number;
  paneId: string;
  closed: boolean;
  onEvent: (event: SubscriptionEvent) => void;
  resolveClosed: () => void;
}

/**
 * Fake Herdr client. Several subscriptions may be open on the same pane at the
 * same time (one per watching session), and each one gets every event.
 */
class FakeClient implements WatcherClient {
  subscriptions: FakeSubscription[] = [];
  agents = new Map<string, AgentInfo>();
  tail = "all tests pass\n❯ \n";
  readFails = false;
  getAgentError: Error | undefined;
  getAgentCalls: string[] = [];
  /** Mimics a client that exposes the `subscription_started` ack. */
  provideReady = true;
  #nextId = 1;

  constructor(...agents: AgentInfo[]) {
    for (const agent of agents) this.agents.set(agent.pane_id, agent);
  }

  subscribe(specs: SubscriptionSpec[], onEvent: (event: SubscriptionEvent) => void): Subscription {
    const spec = specs.find((s) => s.type === "pane.agent_status_changed") as { pane_id: string } | undefined;
    const paneId = spec?.pane_id ?? "*";
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const entry: FakeSubscription = { id: this.#nextId++, paneId, closed: false, onEvent, resolveClosed };
    this.subscriptions.push(entry);
    const handle: Omit<Subscription, "ready"> & { ready?: Promise<void> } = {
      close: () => {
        if (entry.closed) return;
        entry.closed = true;
        resolveClosed();
      },
      closed,
    };
    if (this.provideReady) handle.ready = Promise.resolve();
    return handle as Subscription;
  }

  open(paneId?: string): FakeSubscription[] {
    return this.subscriptions.filter((s) => !s.closed && (paneId === undefined || s.paneId === paneId));
  }

  emit(paneId: string, status: unknown): void {
    for (const entry of this.open(paneId)) {
      entry.onEvent({ event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: status } });
    }
  }

  emitExit(paneId: string): void {
    for (const entry of this.open(paneId)) entry.onEvent({ event: "pane.exited", data: { pane_id: paneId } });
  }

  /** The Herdr server (or the socket) went away without us asking. */
  dropConnections(paneId: string): void {
    for (const entry of this.open(paneId)) {
      entry.closed = true;
      entry.resolveClosed();
    }
  }

  setAgent(paneId: string, patch: Partial<AgentInfo>): void {
    const current = this.agents.get(paneId);
    if (!current) throw new Error(`unknown pane ${paneId}`);
    this.agents.set(paneId, { ...current, ...patch });
  }

  async readAgent(): Promise<PaneReadResult> {
    if (this.readFails) throw new Error("agent.read exploded");
    return {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      source: "recent",
      format: "text",
      text: this.tail,
      revision: 1,
      truncated: false,
    };
  }

  async getAgent(target: string): Promise<AgentInfo> {
    this.getAgentCalls.push(target);
    if (this.getAgentError) throw this.getAgentError;
    const agent = this.agents.get(target);
    if (!agent) throw new Error(`no agent on ${target}`);
    return agent;
  }
}

class FakeNotifier implements Notifier {
  /** Every attempt, including the ones that threw. */
  attempts: Array<{ pane: string; status: SettledStatus; seq: number }> = [];
  calls: Array<{ pane: string; session: string; status: SettledStatus; text: string; seq: number }> = [];
  /** Number of upcoming attempts that must fail. */
  failures = 0;
  gate: Promise<void> | undefined;

  async notify(watch: WatchRecord, status: SettledStatus, text: string): Promise<void> {
    this.attempts.push({ pane: watch.paneId, status, seq: watch.notificationSeq });
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("injection queue is full");
    }
    this.calls.push({ pane: watch.paneId, session: watch.sessionKey, status, text, seq: watch.notificationSeq });
  }

  statuses(): SettledStatus[] {
    return this.calls.map((call) => call.status);
  }
}

const baseAgent: AgentInfo = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: "term_1",
  agent: "claude",
  agent_status: "working",
  focused: true,
  revision: 1,
  state_change_seq: 10,
};

const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
};

let dirs: string[] = [];
let store: WatchStore;
let client: FakeClient;
let notifier: FakeNotifier;
let watcher: HerdrWatcher;
let clock: Date;

const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
/** Lets pending timers (reconnect) and queued handlers finish. */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await watcher.drain();
};

async function makeWatcher(overrides: Record<string, unknown> = {}): Promise<HerdrWatcher> {
  const made = new HerdrWatcher(client, store, notifier, logger, {
    sweepIntervalMs: 3_600_000,
    subscribeAckTimeoutMs: 0,
    reconnectDelayMs: 0,
    deliveryBackoffMs: [1_000],
    now,
    ...overrides,
  });
  await made.start();
  return made;
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-watch-"));
  dirs.push(dir);
  logs.length = 0;
  clock = new Date("2026-09-20T12:00:00.000Z");
  store = new WatchStore(dir, logger);
  await store.load();
  client = new FakeClient(baseAgent);
  notifier = new FakeNotifier();
  watcher = await makeWatcher();
});

afterEach(async () => {
  await watcher.stop();
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  dirs = [];
});

function startWatch(options: { sessionKey?: string; agent?: Partial<AgentInfo> } = {}) {
  return watcher.watch({
    agent: { ...baseAgent, ...options.agent },
    sessionKey: options.sessionKey ?? "s1",
    promptPreview: "run the tests",
    timeoutMinutes: 10,
  });
}

describe("HerdrWatcher settling", () => {
  it("notifies once when a working agent becomes idle and drops the watch", async () => {
    await startWatch();
    expect(store.list()).toHaveLength(1);
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
    expect(notifier.calls[0]?.text).toContain("finished");
    expect(store.list()).toHaveLength(0);
    expect(client.open()).toHaveLength(0);
  });

  it("keeps the watch after blocked, then settles on idle with a new notification seq", async () => {
    await startWatch();
    client.setAgent("w1:p1", { agent_status: "blocked" });
    client.emit("w1:p1", "blocked");
    await settle();
    expect(notifier.statuses()).toEqual(["blocked"]);
    expect(store.list()).toHaveLength(1);

    client.setAgent("w1:p1", { agent_status: "done", state_change_seq: 12 });
    client.emit("w1:p1", "done");
    await settle();
    expect(notifier.statuses()).toEqual(["blocked", "done"]);
    expect(notifier.calls.map((c) => c.seq)).toEqual([1, 2]);
    expect(store.list()).toHaveLength(0);
  });

  it("does not fire on the idle state a watch started in", async () => {
    client.setAgent("w1:p1", { agent_status: "idle" });
    await startWatch({ agent: { agent_status: "idle" } });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.calls).toHaveLength(0);

    client.setAgent("w1:p1", { agent_status: "working", state_change_seq: 11 });
    client.emit("w1:p1", "working");
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 12 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
  });

  it("settles a completion that happened inside the send window", async () => {
    // The agent was idle when the watch was created, finished before any event
    // could be observed, and is idle again — but state_change_seq moved.
    const record = await startWatch({ agent: { agent_status: "idle" } });
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 14 });
    await watcher.reconcile(record.id, "post-prompt");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
  });

  it("does not claim completion when the sequence did not move", async () => {
    const record = await startWatch({ agent: { agent_status: "idle" } });
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 10 });
    await watcher.reconcile(record.id, "post-prompt");
    await settle();
    expect(notifier.calls).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
  });

  it("keeps the completion evidence across working → unknown → idle", async () => {
    await startWatch({ agent: { agent_status: "idle" } });
    client.emit("w1:p1", "working");
    await settle();
    client.setAgent("w1:p1", { agent_status: "unknown" });
    client.emit("w1:p1", "unknown");
    await settle();
    expect(notifier.calls).toHaveLength(0);
    expect(store.list()[0]?.sawWorking).toBe(true);
    expect(store.list()[0]?.lastStatus).toBe("unknown");

    client.setAgent("w1:p1", { agent_status: "idle" });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
  });

  it("produces one notification when done and pane.exited race", async () => {
    await startWatch();
    client.setAgent("w1:p1", { agent_status: "done", state_change_seq: 11 });
    client.emit("w1:p1", "done");
    client.emitExit("w1:p1");
    await settle();
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.statuses()).toEqual(["done"]);
    expect(store.list()).toHaveLength(0);
  });

  it("reports an exited pane", async () => {
    await startWatch();
    client.emitExit("w1:p1");
    await settle();
    expect(notifier.statuses()).toEqual(["exited"]);
    expect(store.list()).toHaveLength(0);
  });

  it("does not attribute anything when the pane changed occupant", async () => {
    await startWatch();
    client.setAgent("w1:p1", { terminal_id: "term_9", agent_status: "idle", state_change_seq: 40 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["occupant_changed"]);
    expect(notifier.calls[0]?.text).toContain("runs something else");
    expect(notifier.calls[0]?.text).not.toContain("all tests pass");
    expect(store.list()).toHaveLength(0);
  });

  it("treats an unknown status string as unknown and logs it", async () => {
    await startWatch();
    client.emit("w1:p1", "finishing-up");
    await settle();
    expect(notifier.calls).toHaveLength(0);
    expect(logs.some((line) => line.includes("unexpected agent status"))).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("falls back to the event status when agent.get cannot be reached", async () => {
    await startWatch();
    client.emit("w1:p1", "working");
    await settle();
    client.getAgentError = new Error("socket gone");
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
  });

  it("fires the deadline from the sweep with the injected clock", async () => {
    await startWatch();
    await watcher.sweep();
    expect(notifier.calls).toHaveLength(0);
    advance(11 * 60_000);
    await watcher.sweep();
    await settle();
    expect(notifier.statuses()).toEqual(["timed_out"]);
    expect(store.list()).toHaveLength(0);
  });

  it("still notifies when reading the pane fails", async () => {
    await startWatch();
    client.readFails = true;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
  });
});

describe("HerdrWatcher delivery", () => {
  it("keeps the watch when notify fails and retries it with backoff", async () => {
    await startWatch();
    notifier.failures = 1;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.calls).toHaveLength(0);
    const pending = store.list()[0]?.pendingDelivery;
    expect(pending?.status).toBe("idle");
    expect(pending?.attempts).toBe(1);
    expect(store.list()[0]?.settledStatus).toBe("idle");

    // Too early: the backoff has not elapsed.
    await watcher.sweep();
    await settle();
    expect(notifier.calls).toHaveLength(0);

    advance(1_000);
    await watcher.sweep();
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
    expect(notifier.attempts.map((a) => a.seq)).toEqual([1, 1]);
    expect(store.list()).toHaveLength(0);
    expect(client.open()).toHaveLength(0);
  });

  it("does not settle twice while a terminal delivery is pending", async () => {
    await startWatch();
    notifier.failures = 1;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(store.list()).toHaveLength(1);

    // A second idle arrives while the first notification is still undelivered:
    // no second settle, and the backoff still holds, so no extra attempt.
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.attempts).toHaveLength(1);
    expect(notifier.calls).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(logs.some((line) => line.includes("already settled as idle"))).toBe(true);

    advance(1_000);
    await watcher.sweep();
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
    expect(notifier.attempts).toHaveLength(2);
    expect(store.list()).toHaveLength(0);
  });

  it("delivers a pending blocked notification and still handles the later idle", async () => {
    await startWatch();
    notifier.failures = 1;
    client.setAgent("w1:p1", { agent_status: "blocked" });
    client.emit("w1:p1", "blocked");
    await settle();
    expect(notifier.calls).toHaveLength(0);
    expect(store.list()[0]?.pendingDelivery?.status).toBe("blocked");

    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 12 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.statuses()).toEqual(["blocked", "idle"]);
    expect(store.list()).toHaveLength(0);
  });

  it("keeps retrying a failed delivery and only gives up at the watch deadline", async () => {
    await startWatch();
    notifier.failures = 99;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(store.list()).toHaveLength(1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      advance(1_000);
      await watcher.sweep();
      await settle();
      // Still settled, still undelivered, still watched: nothing is lost.
      expect(store.list()).toHaveLength(1);
      expect(notifier.calls).toHaveLength(0);
    }
    expect(notifier.attempts).toHaveLength(4);

    advance(10 * 60_000);
    await watcher.sweep();
    await settle();
    expect(store.list()).toHaveLength(0);
    expect(notifier.calls).toHaveLength(0);
    expect(logs.some((line) => line.includes("dropping the undelivered idle notification"))).toBe(true);
  });

  it("does not time out a watch that already settled and is waiting for delivery", async () => {
    await startWatch();
    notifier.failures = 1;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();

    advance(1_000);
    await watcher.sweep();
    await settle();
    expect(notifier.statuses()).toEqual(["idle"]);
    expect(logs.some((line) => line.includes("timed_out"))).toBe(false);
  });
});

describe("HerdrWatcher subscriptions", () => {
  it("closes the previous subscription when the same session re-watches a pane", async () => {
    const first = await startWatch();
    const second = await startWatch();
    expect(second.id).not.toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(client.open("w1:p1")).toHaveLength(1);
    expect(client.subscriptions.filter((s) => s.closed)).toHaveLength(1);
  });

  it("keeps one watch per session and notifies both", async () => {
    await startWatch({ sessionKey: "s1" });
    await startWatch({ sessionKey: "s2" });
    expect(store.list()).toHaveLength(2);
    expect(client.open("w1:p1")).toHaveLength(2);

    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.calls.map((c) => c.session).sort()).toEqual(["s1", "s2"]);
    expect(store.list()).toHaveLength(0);
  });

  it("unwatch only removes the caller's own watch", async () => {
    await startWatch({ sessionKey: "s1" });
    await startWatch({ sessionKey: "s2" });
    expect(await watcher.unwatch("w1:p1", "s1")).toBe(1);
    expect(store.list().map((w) => w.sessionKey)).toEqual(["s2"]);
    expect(client.open("w1:p1")).toHaveLength(1);
    expect(await watcher.unwatch("w1:p1", "s1")).toBe(0);
    expect(await watcher.unwatch("w1:p1")).toBe(1);
    expect(client.open("w1:p1")).toHaveLength(0);
  });

  it("resubscribes and reconciles with Herdr after a dropped connection", async () => {
    await startWatch();
    client.getAgentCalls.length = 0;
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 21 });
    client.dropConnections("w1:p1");
    await settle();
    expect(client.getAgentCalls).toContain("w1:p1");
    expect(notifier.statuses()).toEqual(["idle"]);
  });

  it("restores watches from the store and reconciles on start", async () => {
    await store.add({
      paneId: "w1:p1",
      terminalId: "term_1",
      agentLabel: "claude",
      sessionKey: "s9",
      promptPreview: "p",
      deadlineAt: new Date(clock.getTime() + 60_000).toISOString(),
      seqAtStart: 10,
      lastStatus: "working",
      sawWorking: true,
    });
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    const second = new HerdrWatcher(client, store, notifier, logger, {
      sweepIntervalMs: 3_600_000,
      subscribeAckTimeoutMs: 0,
      now,
    });
    await second.start();
    await second.drain();
    expect(notifier.statuses()).toEqual(["idle"]);
    await second.stop();
  });

  it("waits for the ack fallback when the client exposes no ready promise", async () => {
    await watcher.stop();
    client.provideReady = false;
    watcher = await makeWatcher({ subscribeAckTimeoutMs: 5 });
    const record = await startWatch();
    expect(store.byId(record.id)).toBeDefined();
    expect(client.open("w1:p1")).toHaveLength(1);
  });

  it("stop() waits for a handler that is still running", async () => {
    await startWatch();
    let release!: () => void;
    notifier.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 11 });
    client.emit("w1:p1", "idle");
    await new Promise((resolve) => setImmediate(resolve));

    let stopped = false;
    const stopping = watcher.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(notifier.statuses()).toEqual(["idle"]);
    expect(store.list()).toHaveLength(0);

    // Events after stop() are ignored.
    notifier.gate = undefined;
    client.emit("w1:p1", "idle");
    await settle();
    expect(notifier.calls).toHaveLength(1);
  });
});
