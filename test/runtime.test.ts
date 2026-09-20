import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrRequestError, HerdrTransportError, type HerdrClient, type Subscription } from "../src/herdr/client.js";
import type { AgentInfo } from "../src/herdr/types.js";
import { HerdrRuntime } from "../src/openclaw/runtime.js";
import { readPluginConfig } from "../src/openclaw/config.js";

const agents: AgentInfo[] = [
  { pane_id: "w6:p1", workspace_id: "w6", tab_id: "w6:t1", terminal_id: "term_1", agent: "claude", agent_status: "idle", focused: true, revision: 1, state_change_seq: 5, foreground_cwd: "/home/u/proj" },
];

interface FakeClientExtras {
  prompts: Array<{ target: string; text: string }>;
  trace: string[];
  subscriptions: number;
}

function fakeClient(overrides: Partial<Record<keyof HerdrClient, unknown>> = {}): HerdrClient & FakeClientExtras {
  const prompts: Array<{ target: string; text: string }> = [];
  const trace: string[] = [];
  const client = {
    socketPath: "/fake.sock",
    trace,
    prompts,
    subscriptions: 0,
    listAgents: async () => agents,
    getAgent: async (target: string) => {
      trace.push(`getAgent:${target}`);
      return agents.find((a) => a.pane_id === target);
    },
    readAgent: async () => ({ text: "❯ \n" }),
    prompt: async (target: string, text: string) => {
      trace.push(`prompt:${target}`);
      prompts.push({ target, text });
      return {};
    },
    subscribe: (): Subscription & { ready?: Promise<void> } => {
      trace.push("subscribe");
      client.subscriptions += 1;
      return { close: () => {}, closed: new Promise<void>(() => {}), ready: Promise.resolve() };
    },
    ...overrides,
  };
  return client as unknown as HerdrClient & FakeClientExtras;
}

const started: Array<{ runtime: HerdrRuntime; dir: string }> = [];

async function makeRuntime(client = fakeClient()) {
  const notified: Array<{ status: string; session: string }> = [];
  const logs: string[] = [];
  const runtime = new HerdrRuntime(
    readPluginConfig({}),
    { notify: async (watch, status) => void notified.push({ status, session: watch.sessionKey }) },
    { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    client,
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-rt-"));
  await runtime.start(dir);
  started.push({ runtime, dir });
  return { runtime, notified, logs, client: client as unknown as HerdrClient & FakeClientExtras };
}

afterEach(async () => {
  for (const { runtime, dir } of started) {
    await runtime.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
  started.length = 0;
});

describe("HerdrRuntime commands", () => {
  it("lists agents", async () => {
    const { runtime } = await makeRuntime();
    const out = await runtime.handleCommand("list", {});
    expect(out).toContain("w6:p1");
    expect(out).toContain("claude");
  });

  it("sends a prompt to the only agent and starts a watch", async () => {
    const { runtime, client } = await makeRuntime();
    const out = await runtime.handleCommand("run the tests", { sessionKey: "agent:main:telegram:1" });
    expect(client.prompts).toEqual([{ target: "w6:p1", text: "run the tests" }]);
    expect(out).toContain("Sent to **w6:p1**");
    expect(out).toContain("I will tell you");
  });

  it("opens the subscription before prompting", async () => {
    const { runtime, client } = await makeRuntime();
    await runtime.handleCommand("run the tests", { sessionKey: "s1" });
    expect(client.trace.indexOf("subscribe")).toBeGreaterThanOrEqual(0);
    expect(client.trace.indexOf("subscribe")).toBeLessThan(client.trace.indexOf("prompt:w6:p1"));
  });

  it("notifies a task that finished before any event arrived", async () => {
    // agent.get reports idle with a higher state_change_seq right after the
    // prompt: the task ran and came back while nobody was listening.
    const client = fakeClient({
      getAgent: async () => ({ ...agents[0], agent_status: "idle", state_change_seq: 9 }),
    });
    const { runtime, notified } = await makeRuntime(client);
    const out = await runtime.handleCommand("w6:p1: reply with OK", { sessionKey: "s1" });
    expect(out).toContain("Sent to **w6:p1**");
    expect(notified).toEqual([{ status: "idle", session: "s1" }]);
  });

  it("says the prompt was delivered when the watch could not be set up", async () => {
    const client = fakeClient({
      subscribe: () => {
        throw new Error("socket refused");
      },
    });
    const { runtime, notified } = await makeRuntime(client);
    const out = await runtime.handleCommand("run the tests", { sessionKey: "s1" });
    expect(client.prompts).toHaveLength(1);
    expect(out).toContain("Sent to **w6:p1**");
    expect(out).toContain("could not set up the watch");
    expect(notified).toHaveLength(0);
    // Nothing half-registered: the failed watch left no record behind.
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s1" })).toContain("was not being watched");
  });

  it("reports an uncertain send when the transport dies mid-prompt", async () => {
    const client = fakeClient({
      prompt: async () => {
        throw new HerdrTransportError("connection reset");
      },
    });
    const { runtime } = await makeRuntime(client);
    const out = await runtime.handleCommand("run the tests", { sessionKey: "s1" });
    expect(out).toContain("could not confirm the send");
    expect(out).toContain("may have been delivered");
    // The watch is kept, in case the prompt did land.
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s1" })).toContain("Stopped watching");
  });

  it("says nothing was sent when Herdr refuses the prompt, and keeps no watch", async () => {
    const client = fakeClient({
      prompt: async () => {
        throw new HerdrRequestError({ code: "agent_blocked", message: "agent is at a prompt" });
      },
    });
    const { runtime } = await makeRuntime(client);
    const out = await runtime.handleCommand("run the tests", { sessionKey: "s1" });
    expect(out).toContain("Nothing was sent to w6:p1");
    expect(out).toContain("waiting at a prompt");
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s1" })).toContain("was not being watched");
  });

  it("refuses to send to a blocked agent and shows the prompt instead", async () => {
    const blocked = fakeClient({ listAgents: async () => [{ ...agents[0], agent_status: "blocked" }] });
    const { runtime, client } = await makeRuntime(blocked);
    const out = await runtime.handleCommand("w6:p1: continue", { sessionKey: "s" });
    expect(client.prompts).toEqual([]);
    expect(out).toContain("waiting for input");
  });

  it("scopes unwatch to the calling session", async () => {
    const { runtime } = await makeRuntime();
    expect(await runtime.handleCommand("watch w6:p1", { sessionKey: "s1" })).toContain("Watching w6:p1");
    expect(await runtime.handleCommand("watch w6:p1", { sessionKey: "s2" })).toContain("Watching w6:p1");
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s1" })).toBe("Stopped watching w6:p1.");
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s1" })).toContain("watched by another chat");
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s2" })).toBe("Stopped watching w6:p1.");
    expect(await runtime.handleCommand("unwatch w6:p1", { sessionKey: "s2" })).toContain("was not being watched");
  });

  it("explains transport failures in plain words", async () => {
    const down = fakeClient({
      listAgents: async () => {
        throw new HerdrTransportError("ENOENT");
      },
    });
    const { runtime } = await makeRuntime(down);
    expect(await runtime.handleCommand("list", {})).toContain("Cannot reach Herdr");
  });
});
