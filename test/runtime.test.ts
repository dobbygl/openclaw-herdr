import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError, HerdrTransportError, type Subscription } from "../src/herdr/client.js";
import type { AgentInfo } from "../src/herdr/types.js";
import { ServerRegistry } from "../src/core/servers.js";
import { HerdrRuntime } from "../src/openclaw/runtime.js";
import { readPluginConfig } from "../src/openclaw/config.js";
import { type FakeHerdr, startFakeHerdr } from "./fixtures/fake-herdr-server.js";

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
    listTabs: async () => [],
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

/**
 * A runtime with remote machines switched off, so nothing in this file can
 * spawn `herdr` or `ssh` on the machine running the tests. The remote paths are
 * covered with an injected registry over the fake CLIs (see below).
 */
/** Polls until `check` holds, so an event-driven notification can be awaited. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeRuntime(client = fakeClient(), registry?: ServerRegistry) {
  const notified: Array<{ status: string; session: string; text: string }> = [];
  const logs: string[] = [];
  const runtime = new HerdrRuntime(
    readPluginConfig({ remote: { enabled: registry !== undefined } }),
    { notify: async (watch, status, text) => void notified.push({ status, session: watch.sessionKey, text }) },
    { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    client,
    registry,
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
    expect(notified.map((n) => ({ status: n.status, session: n.session }))).toEqual([
      { status: "idle", session: "s1" },
    ]);
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

/**
 * The same runtime with two saved Herdr machines, discovered through the fake
 * `herdr` CLI and reached through the fake `ssh` in front of a fake Herdr
 * server. Both machines answer with the same pane ids as the local fake, which
 * is exactly the confusion the `@server` suffix has to prevent. No real machine
 * is contacted.
 */
describe("HerdrRuntime with tab labels", () => {
  // The issue's shape, with synthetic names: two single-pane tabs, agents
  // without a Herdr name, labels only in `tab.list`.
  const herd: AgentInfo[] = [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term_1", agent: "claude", agent_status: "idle", focused: false, revision: 1 },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", terminal_id: "term_2", agent: "codex", agent_status: "idle", focused: false, revision: 1 },
  ];
  const tabs = [
    { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "sample#reviewer" },
    { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "sample#builder" },
  ];
  const labelled = (listTabs: () => Promise<unknown>) =>
    fakeClient({ listAgents: async () => herd, listTabs, getAgent: async (target: string) => herd.find((a) => a.pane_id === target) });

  it("lists labels first and sends to a tab label", async () => {
    const client = labelled(async () => tabs);
    const { runtime } = await makeRuntime(client);
    const list = await runtime.handleCommand("list", {});
    expect(list).toContain("**sample#reviewer** claude · w1:p1 · idle");
    expect(list).toContain("**sample#builder** codex · w1:p2 · idle");
    const out = await runtime.handleCommand("sample#builder: run the tests", { sessionKey: "s1" });
    expect(client.prompts).toEqual([{ target: "w1:p2", text: "run the tests" }]);
    expect(out).toContain("Sent to **w1:p2** (sample#builder).");
    expect(await runtime.handleCommand("status sample#reviewer", {})).toContain("**sample#reviewer** claude · w1:p1");
  });

  it("falls back to ids and kinds when Herdr does not know tab.list", async () => {
    const client = labelled(async () => {
      throw new HerdrRequestError({ code: "invalid_request", message: "invalid request: unknown variant `tab.list`" });
    });
    const { runtime } = await makeRuntime(client);
    expect(await runtime.handleCommand("list", {})).toContain("**w1:p1** claude · idle");
    const missing = await runtime.handleCommand("sample#builder: run the tests", { sessionKey: "s1" });
    expect(missing).toContain("No agent matches sample#builder");
    await runtime.handleCommand("codex: run the tests", { sessionKey: "s1" });
    expect(client.prompts).toEqual([{ target: "w1:p2", text: "run the tests" }]);
  });

  it("refuses to send when tab.list is refused for another reason", async () => {
    const client = labelled(async () => {
      throw new HerdrRequestError({ code: "permission_denied", message: "tab.list is not allowed" });
    });
    const { runtime } = await makeRuntime(client);
    const out = await runtime.handleCommand("w1:p2: run the tests", { sessionKey: "s1" });
    expect(out).toContain("permission_denied");
    expect(client.prompts).toEqual([]);
    // `/herdr list` shows the refusal in place of a herd, never an unlabelled one.
    const list = await runtime.handleCommand("list", {});
    expect(list).toContain("tab.list is not allowed (permission_denied)");
    expect(list).not.toContain("w1:p1");
  });

  it("reports a tab.list transport failure instead of an unlabelled herd", async () => {
    const client = labelled(async () => {
      throw new HerdrTransportError("Herdr socket error for tab.list: connection reset");
    });
    const { runtime } = await makeRuntime(client);
    const out = await runtime.handleCommand("w1:p2: run the tests", { sessionKey: "s1" });
    expect(out).toContain("Cannot reach Herdr");
    expect(client.prompts).toEqual([]);
  });
});

describe("HerdrRuntime with machines", () => {
  const FAKE_HERDR = fileURLToPath(new URL("./fixtures/fake-herdr-cli.mjs", import.meta.url));
  const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
  const BUILDBOX_ID = "abc123def4567890";
  /** The local herd: one pane whose id also exists on the machines. */
  const localAgents: AgentInfo[] = [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term_local",
      agent: "claude",
      agent_status: "idle",
      focused: true,
      revision: 1,
      state_change_seq: 5,
      terminal_title_stripped: "local task",
    },
  ];

  let herdr: FakeHerdr;
  let dir: string;

  function localClient(here: AgentInfo[] = localAgents) {
    return fakeClient({
      listAgents: async () => here,
      getAgent: async (target: string) => here.find((a) => a.pane_id === target),
    });
  }

  async function withMachines(options: { allowSend?: string[]; localAgents?: AgentInfo[] } = {}) {
    const client = localClient(options.localAgents);
    const registry = new ServerRegistry({
      herdrBin: FAKE_HERDR,
      sshBin: FAKE_SSH,
      stateDir: dir,
      localClient: client as unknown as HerdrClient,
      ...(options.allowSend ? { allowSend: options.allowSend } : {}),
    });
    return makeRuntime(client, registry);
  }

  beforeEach(async () => {
    herdr = await startFakeHerdr("herdr-rt-remote-");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-rt-state-"));
    process.env.FAKE_HERDR_SOCKET = herdr.socketPath;
  });

  afterEach(async () => {
    delete process.env.FAKE_HERDR_SOCKET;
    delete process.env.FAKE_SSH_FAIL;
    await herdr.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("groups the list by machine with copyable refs", async () => {
    const { runtime } = await withMachines();
    const out = await runtime.handleCommand("list", {});
    const lines = out.split("\n");
    expect(lines[0]).toBe("Herdr agents:");
    expect(out).toContain("**w1:p1** claude · idle — local task");
    expect(out).toContain("Machine buildbox:");
    expect(out).toContain("**w1:p1@buildbox**");
    expect(out).toContain("Machine lab:");
    expect(out).toContain("**w1:p2@lab**");
    // Local rows stay unqualified, so the two w1:p1 cannot be confused.
    expect(out).not.toContain("**w1:p1@local**");
  });

  it("shows a machine it cannot reach as down, with a short reason", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    const { runtime } = await withMachines();
    const out = await runtime.handleCommand("list", {});
    expect(out).toContain("**w1:p1** claude");
    expect(out).toMatch(/Machine buildbox: down — .*denied/iu);
    expect(out).toMatch(/Machine lab: down — /u);
  });

  it("resolves the same pane id independently on each server", async () => {
    const { runtime } = await withMachines();
    const here = await runtime.handleCommand("status w1:p1", {});
    expect(here).toContain("**w1:p1**");
    expect(here).toContain("local task");

    const there = await runtime.handleCommand("status w1:p1@buildbox", {});
    expect(there).toContain("**w1:p1@buildbox**");
    expect(there).not.toContain("local task");

    // And a read carries the machine too.
    expect(await runtime.handleCommand("read w1:p1@buildbox", {})).toBe("w1:p1@buildbox shows nothing yet.");
  });

  it("lists the known servers for an unknown @suffix", async () => {
    const { runtime } = await withMachines();
    const out = await runtime.handleCommand("status w1:p1@nowhere", {});
    expect(out).toContain('"nowhere"');
    expect(out).toContain("local");
    expect(out).toContain("buildbox");
    expect(out).toContain("lab");
  });

  it("refuses a remote send until the machine is in allowSend", async () => {
    const { runtime, client } = await withMachines();
    const refused = await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
    expect(refused).toContain("**w1:p1@buildbox**");
    expect(refused).toContain("read-only");
    expect(refused).toContain("remote.allowSend");
    // Nothing was typed anywhere, least of all locally.
    expect(client.prompts).toEqual([]);
    expect(await runtime.handleCommand("unwatch w1:p1@buildbox", { sessionKey: "s1" })).toContain(
      "was not being watched",
    );
  });

  it("allows a remote send by label and by id, and confirms it with the qualified ref", async () => {
    for (const allowSend of [["buildbox"], [BUILDBOX_ID]]) {
      herdr.prompts.length = 0;
      const { runtime, client } = await withMachines({ allowSend });
      const out = await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
      expect(out).not.toContain("read-only");
      expect(out).toContain("Sent to **w1:p1@buildbox**");
      expect(out).toContain("I will tell you when it finishes");
      expect(herdr.prompts).toEqual([{ target: "w1:p1", text: "run the tests" }]);
      // The local pane with the same id was never touched.
      expect(client.prompts).toEqual([]);
      // `lab` is still read-only: allowSend is per machine.
      expect(await runtime.handleCommand("w1:p1@lab: run the tests", { sessionKey: "s1" })).toContain("read-only");
    }
  });

  it("notifies a finished remote task with the qualified ref", async () => {
    const { runtime, notified } = await withMachines({ allowSend: ["buildbox"] });
    expect(await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" })).toContain(
      "Sent to **w1:p1@buildbox**",
    );
    herdr.emit("w1:p1", "working");
    herdr.setAgent("w1:p1", { agent_status: "done" });
    herdr.emit("w1:p1", "done");
    await waitFor(() => notified.length > 0);
    expect(notified[0]?.status).toBe("done");
    expect(notified[0]?.text).toContain("**w1:p1@buildbox**");
  });

  it("answers a bare prompt with one line, not the whole herd", async () => {
    const two = [...localAgents, { ...(localAgents[0] as AgentInfo), pane_id: "w1:p9", terminal_id: "term_other" }];
    const { runtime, client } = await withMachines({ localAgents: two });
    const out = await runtime.handleCommand("run the tests", { sessionKey: "s1" });
    expect(out).toContain("Several agents are running");
    expect(out).toContain("w1:p9");
    // No machine groups, no pings: a prompt does not ask for an inventory.
    expect(out).not.toContain("Machine buildbox:");
    expect(out.split("\n")).toHaveLength(1);
    expect(client.prompts).toEqual([]);
    // `status` still answers with the full, grouped list.
    expect(await runtime.handleCommand("status", {})).toContain("Machine buildbox:");
  });

  it("watches and unwatches a remote pane, scoped to its machine", async () => {
    const { runtime } = await withMachines();
    expect(await runtime.handleCommand("watch w1:p1@buildbox", { sessionKey: "s1" })).toContain(
      "Watching w1:p1@buildbox",
    );
    expect(await runtime.handleCommand("list", {})).toContain("watching");
    // The local pane with the same id is not watched.
    expect(await runtime.handleCommand("unwatch w1:p1", { sessionKey: "s1" })).toContain("was not being watched");
    expect(await runtime.handleCommand("unwatch w1:p1@buildbox", { sessionKey: "s1" })).toBe(
      "Stopped watching w1:p1@buildbox.",
    );
  });
});

describe("HerdrRuntime start", () => {
  let fake: FakeHerdr;
  afterEach(async () => {
    await fake?.close();
  });

  async function runtimeOnFake(): Promise<{ runtime: HerdrRuntime }> {
    fake = await startFakeHerdr();
    const client = new HerdrClient({ socketPath: fake.socketPath });
    return makeRuntime(client as HerdrClient & FakeClientExtras);
  }

  it("opens a new tab and starts the agent, then targets it by name", async () => {
    const { runtime } = await runtimeOnFake();
    const out = await runtime.handleCommand("start cuento codex ~/tales", {});
    expect(fake.created).toEqual([{ label: "cuento", cwd: "~/tales" }]);
    expect(fake.starts).toEqual([{ name: "cuento", kind: "codex", paneId: "w1:p90", args: undefined }]);
    expect(out).toContain("Started **cuento** (codex) in **w1:p90** (new pane)");
    const sent = await runtime.handleCommand("cuento: write a story", { sessionKey: "s" });
    expect(fake.prompts).toEqual([{ target: "w1:p90", text: "write a story" }]);
    expect(sent).toContain("Sent to **w1:p90**");
  });

  it("waits for a brand-new pane's shell and retries a busy start", async () => {
    const { runtime } = await runtimeOnFake();
    fake.busyOnStart("w1:p90", 2);
    const out = await runtime.handleCommand("start cuento", {});
    expect(fake.created).toHaveLength(1);
    // pane.process_info was polled until the shell was alone in the foreground
    expect(fake.processInfoCalls.filter((p) => p === "w1:p90").length).toBeGreaterThanOrEqual(3);
    expect(fake.starts).toEqual([{ name: "cuento", kind: "claude", paneId: "w1:p90", args: undefined }]);
    expect(out).toContain("Started **cuento**");
  });

  it("reuses an empty pane whose label matches the name", async () => {
    const { runtime } = await runtimeOnFake();
    fake.addShellPane("w1:p7", "cuento");
    const out = await runtime.handleCommand("start cuento", {});
    expect(fake.created).toEqual([]);
    expect(fake.starts).toEqual([{ name: "cuento", kind: "claude", paneId: "w1:p7", args: undefined }]);
    expect(out).toContain("in **w1:p7**");
    expect(out).not.toContain("new pane");
  });

  it("uses a pane id given after the name and refuses a pane that is busy or missing", async () => {
    const { runtime } = await runtimeOnFake();
    fake.addShellPane("w1:p8", "scratch");
    const out = await runtime.handleCommand("start cuento w1:p8", {});
    expect(fake.starts).toEqual([{ name: "cuento", kind: "claude", paneId: "w1:p8", args: undefined }]);
    expect(out).toContain("in **w1:p8**");
    expect(await runtime.handleCommand("start other w1:p8", {})).toContain("already runs");
    expect(await runtime.handleCommand("start other w1:p99", {})).toContain("no pane w1:p99");
    expect(fake.created).toEqual([]);
  });

  it("refuses a name that already runs an agent", async () => {
    const { runtime } = await runtimeOnFake();
    fake.addShellPane("w1:p7", "cuento");
    await runtime.handleCommand("start cuento", {});
    const again = await runtime.handleCommand("start cuento", {});
    expect(again).toContain("already runs");
    expect(fake.starts).toHaveLength(1);
  });

  it("relays Herdr's refusal when the agent cannot be started", async () => {
    const { runtime } = await runtimeOnFake();
    const out = await runtime.handleCommand("start busy nope", {});
    expect(out).toContain("could not start nope as busy");
    expect(out).toContain("unsupported_kind");
    expect(fake.starts).toEqual([]);
  });
});
