import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { Subscription } from "../src/herdr/client.js";
import type { AgentInfo, SubscriptionEvent, SubscriptionSpec } from "../src/herdr/types.js";
import { WatchStore } from "../src/core/watch-store.js";
import { HerdrWatcher, type Notifier, type SettledStatus, type WatcherClient } from "../src/core/watcher.js";

class FakeClient implements WatcherClient {
  handlers = new Map<string, (event: SubscriptionEvent) => void>();
  subscribe(specs: SubscriptionSpec[], onEvent: (event: SubscriptionEvent) => void): Subscription {
    const spec = specs.find((s) => s.type === "pane.agent_status_changed") as { pane_id: string } | undefined;
    const paneId = spec?.pane_id ?? "*";
    this.handlers.set(paneId, onEvent);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    return { close: () => { this.handlers.delete(paneId); resolveClosed(); }, closed };
  }
  emit(paneId: string, status: string) {
    this.handlers.get(paneId)?.({ event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: status } });
  }
  emitExit(paneId: string) {
    this.handlers.get(paneId)?.({ event: "pane.exited", data: { pane_id: paneId } });
  }
  async readAgent() {
    return { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "recent" as const, format: "text" as const, text: "done\n❯ \n", revision: 1, truncated: false };
  }
  async getAgent(): Promise<AgentInfo> {
    return agent;
  }
}

class FakeNotifier implements Notifier {
  calls: Array<{ pane: string; status: SettledStatus; text: string }> = [];
  async notify(watch: { paneId: string }, status: SettledStatus, text: string) {
    this.calls.push({ pane: watch.paneId, status, text });
  }
}

const agent: AgentInfo = {
  pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term_1",
  agent: "claude", agent_status: "working", focused: true, revision: 1, state_change_seq: 10,
};

let store: WatchStore;
let client: FakeClient;
let notifier: FakeNotifier;
let watcher: HerdrWatcher;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-watch-"));
  store = new WatchStore(dir);
  await store.load();
  client = new FakeClient();
  notifier = new FakeNotifier();
  watcher = new HerdrWatcher(client, store, notifier, {}, { sweepIntervalMs: 60_000 });
  await watcher.start();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("HerdrWatcher", () => {
  it("notifies once when a working agent becomes idle and drops the watch", async () => {
    await watcher.watch({ agent, sessionKey: "s1", promptPreview: "run tests", timeoutMinutes: 10 });
    expect(store.list()).toHaveLength(1);
    client.emit("w1:p1", "idle");
    await tick();
    expect(notifier.calls.map((c) => c.status)).toEqual(["idle"]);
    expect(notifier.calls[0]?.text).toContain("finished");
    expect(store.list()).toHaveLength(0);
    expect(client.handlers.size).toBe(0);
  });

  it("keeps the watch after blocked, then settles on idle", async () => {
    await watcher.watch({ agent, sessionKey: "s1", promptPreview: "x", timeoutMinutes: 10 });
    client.emit("w1:p1", "blocked");
    await tick();
    expect(notifier.calls.map((c) => c.status)).toEqual(["blocked"]);
    expect(store.list()).toHaveLength(1);
    client.emit("w1:p1", "working");
    client.emit("w1:p1", "done");
    await tick();
    expect(notifier.calls.map((c) => c.status)).toEqual(["blocked", "done"]);
    expect(store.list()).toHaveLength(0);
  });

  it("does not fire on the idle state a watch started in", async () => {
    await watcher.watch({ agent: { ...agent, agent_status: "idle" }, sessionKey: "s1", promptPreview: "x", timeoutMinutes: 10 });
    client.emit("w1:p1", "idle");
    await tick();
    expect(notifier.calls).toHaveLength(0);
    client.emit("w1:p1", "working");
    client.emit("w1:p1", "idle");
    await tick();
    expect(notifier.calls.map((c) => c.status)).toEqual(["idle"]);
  });

  it("reports an exited pane", async () => {
    await watcher.watch({ agent, sessionKey: "s1", promptPreview: "x", timeoutMinutes: 10 });
    client.emitExit("w1:p1");
    await tick();
    expect(notifier.calls.map((c) => c.status)).toEqual(["exited"]);
    expect(store.list()).toHaveLength(0);
  });

  it("restores watches from the store on start", async () => {
    await store.add({ paneId: "w2:p1", terminalId: "t", agentLabel: "codex", sessionKey: "s9", promptPreview: "p", deadlineAt: new Date(Date.now() + 60_000).toISOString(), seqAtStart: 1, lastStatus: "working" });
    const second = new HerdrWatcher(client, store, notifier, {}, { sweepIntervalMs: 60_000 });
    await second.start();
    expect(client.handlers.has("w2:p1")).toBe(true);
    await second.stop();
  });
});
