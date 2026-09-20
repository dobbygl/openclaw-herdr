import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { HerdrClient } from "../src/herdr/client.js";
import type { AgentInfo } from "../src/herdr/types.js";
import { HerdrRuntime } from "../src/openclaw/runtime.js";
import { readPluginConfig } from "../src/openclaw/config.js";

const agents: AgentInfo[] = [
  { pane_id: "w6:p1", workspace_id: "w6", tab_id: "w6:t1", terminal_id: "term_1", agent: "claude", agent_status: "idle", focused: true, revision: 1, state_change_seq: 5, foreground_cwd: "/home/u/proj" },
];

function fakeClient(overrides: Partial<Record<keyof HerdrClient, unknown>> = {}): HerdrClient {
  const prompts: Array<{ target: string; text: string }> = [];
  const client = {
    socketPath: "/fake.sock",
    listAgents: async () => agents,
    getAgent: async (target: string) => agents.find((a) => a.pane_id === target),
    readAgent: async () => ({ text: "❯ \n" }),
    prompt: async (target: string, text: string) => { prompts.push({ target, text }); return {}; },
    subscribe: () => ({ close() {}, closed: new Promise<void>(() => {}) }),
    prompts,
    ...overrides,
  };
  return client as unknown as HerdrClient;
}

async function makeRuntime(client = fakeClient()) {
  const notified: string[] = [];
  const runtime = new HerdrRuntime(readPluginConfig({}), { notify: async (_w, s) => { notified.push(s); } }, {}, client);
  await runtime.start(await fs.mkdtemp(path.join(os.tmpdir(), "herdr-rt-")));
  return { runtime, notified, client: client as unknown as { prompts: Array<{ target: string; text: string }> } };
}

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
    expect(out).toContain("Sent to w6:p1");
    expect(out).toContain("I will tell you");
  });

  it("refuses to send to a blocked agent and shows the prompt instead", async () => {
    const blocked = fakeClient({ listAgents: async () => [{ ...agents[0], agent_status: "blocked" }] });
    const { runtime, client } = await makeRuntime(blocked);
    const out = await runtime.handleCommand("w6:p1: continue", { sessionKey: "s" });
    expect(client.prompts).toEqual([]);
    expect(out).toContain("waiting for input");
  });

  it("explains transport failures in plain words", async () => {
    const down = fakeClient({ listAgents: async () => { const { HerdrTransportError } = await import("../src/herdr/client.js"); throw new HerdrTransportError("ENOENT"); } });
    const { runtime } = await makeRuntime(down);
    expect(await runtime.handleCommand("list", {})).toContain("Cannot reach Herdr");
  });
});
