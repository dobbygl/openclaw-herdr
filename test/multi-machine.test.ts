import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerRegistry } from "../src/core/servers.js";
import type { SettledStatus } from "../src/core/watcher.js";
import { HerdrClient } from "../src/herdr/client.js";
import { readPluginConfig } from "../src/openclaw/config.js";
import type { HostApi, HostTool, HostToolContext } from "../src/openclaw/host-api.js";
import { HerdrRuntime } from "../src/openclaw/runtime.js";
import { registerHerdrTools } from "../src/openclaw/tools.js";
import { startFakeHerdr, type FakeHerdr } from "./fixtures/fake-herdr-server.js";

/**
 * Multi-machine behaviour end to end, through the two public surfaces
 * (`HerdrRuntime.handleCommand` and the `herdr_*` tools), over the real
 * transport seam: a fake `herdr` CLI for `machine list --json`, a fake `ssh`
 * that proxies stdio, and *three* fake Herdr servers — this host plus one per
 * machine — each with its own herd, so nothing here can be right by accident.
 *
 * Nothing in this file touches a real socket, a real ssh or a real machine:
 * `herdrBin`/`sshBin` are the fixtures, `FAKE_SSH_SOCKET_MAP` is the only way
 * to reach a server, and the single-socket fallback (`FAKE_HERDR_SOCKET`) is
 * deliberately unset, so an unmapped target fails loudly instead of wandering
 * off. See the last test in the file, which asserts exactly that.
 */
const FAKE_HERDR = fileURLToPath(new URL("./fixtures/fake-herdr-cli.mjs", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
/** Machine profile ids the fake `herdr machine list --json` reports. */
const BUILDBOX_ID = "abc123def4567890";
const LAB_ID = "ddd444";
/** SSH targets Herdr stored for them. */
const BUILDBOX_TARGET = "buildbox";
const LAB_TARGET = "alice@lab";
/** What each machine's `herdr status server` reports as its socket. */
const BUILDBOX_SOCKET = "/home/alice/.config/herdr/herdr.sock";
const LAB_SOCKET = "/home/alice/.config/herdr/work.sock";

/** This host: one pane whose id also exists on both machines. */
const LOCAL_AGENTS: unknown[] = [
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
    foreground_cwd: "/home/alice/proj",
  },
];

/** buildbox: the same pane id, plus two panes that share the name `reviewer`. */
const BUILDBOX_AGENTS: unknown[] = [
  {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    terminal_id: "term_b1",
    agent: "claude",
    name: "reviewer",
    agent_status: "idle",
    focused: false,
    revision: 1,
    state_change_seq: 3,
    terminal_title_stripped: "buildbox task",
  },
  {
    pane_id: "w1:p2",
    workspace_id: "w1",
    tab_id: "w1:t1",
    terminal_id: "term_b2",
    agent: "codex",
    name: "reviewer",
    agent_status: "idle",
    focused: false,
    revision: 1,
    state_change_seq: 3,
  },
  {
    pane_id: "w1:p3",
    workspace_id: "w1",
    tab_id: "w1:t2",
    terminal_id: "term_b3",
    agent: "claude",
    name: "builder",
    agent_status: "idle",
    focused: false,
    revision: 1,
    state_change_seq: 3,
  },
];

/** lab: the same pane id again, and a `builder` that buildbox also has. */
const LAB_AGENTS: unknown[] = [
  {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    terminal_id: "term_lab1",
    agent: "codex",
    name: "builder",
    agent_status: "idle",
    focused: false,
    revision: 1,
    state_change_seq: 3,
    terminal_title_stripped: "lab task",
  },
];

interface Notification {
  status: SettledStatus;
  session: string;
  text: string;
}

let local: FakeHerdr;
let buildbox: FakeHerdr;
let lab: FakeHerdr;
let dir: string;
let argvFile: string;
let callsFile: string;
let pidFile: string;
let logs: string[];
let notified: Notification[];
/** Injected clock for the registry, so the health TTL is never a race. */
let clock: number;
const started: HerdrRuntime[] = [];

const log = {
  info: (message: string) => void logs.push(message),
  warn: (message: string) => void logs.push(message),
  error: (message: string) => void logs.push(message),
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` holds: the watcher is event-driven and owns its timers. */
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await delay(20);
  }
}

async function argvLines(): Promise<string[][]> {
  const text = await fs.readFile(argvFile, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function herdrCalls(): Promise<string[][]> {
  const text = await fs.readFile(callsFile, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** How often a remote socket path was resolved, i.e. how often a client was built. */
async function socketResolutions(): Promise<number> {
  return (await argvLines()).filter((argv) => (argv.at(-1) ?? "").includes("status server")).length;
}

/** The fake ssh children still alive for one target (the live subscription). */
async function liveSshPids(target: string): Promise<number[]> {
  const text = await fs.readFile(pidFile, "utf8").catch(() => "");
  const pids: number[] = [];
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const [rawPid, recorded] = line.split("\t");
    if (recorded !== target) continue;
    const pid = Number(rawPid);
    try {
      process.kill(pid, 0);
      pids.push(pid);
    } catch {
      // already gone
    }
  }
  return pids;
}

/** One block of `/herdr list`: its rows, without the neighbouring servers'. */
function section(output: string, header: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("Machine ") || line === "Herdr agents:");
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

async function makeRuntime(options: { allowSend?: string[] } = {}): Promise<{
  runtime: HerdrRuntime;
  registry: ServerRegistry;
}> {
  const localClient = new HerdrClient({ socketPath: local.socketPath, requestTimeoutMs: 2_000 });
  const registry = new ServerRegistry({
    herdrBin: FAKE_HERDR,
    sshBin: FAKE_SSH,
    stateDir: dir,
    localClient,
    ...(options.allowSend ? { allowSend: options.allowSend } : {}),
    remoteRequestTimeoutMs: 5_000,
    remoteSubscribeAckTimeoutMs: 5_000,
    pingTimeoutMs: 5_000,
    now: () => clock,
    logger: log,
  });
  const runtime = new HerdrRuntime(
    readPluginConfig({ remote: { enabled: true, allowSend: options.allowSend ?? [] } }),
    { notify: async (watch, status, text) => void notified.push({ status, session: watch.sessionKey, text }) },
    log,
    localClient,
    registry,
  );
  await runtime.start(dir);
  started.push(runtime);
  return { runtime, registry };
}

/** The `herdr_*` tools, registered against a host fake that only collects them. */
function toolsOf(runtime: HerdrRuntime, ctx: HostToolContext = {}): Map<string, HostTool> {
  const tools = new Map<string, HostTool>();
  const api: HostApi = {
    logger: log,
    registerCommand: () => {},
    registerTool: (factory) => {
      const tool = factory(ctx);
      tools.set(tool.name, tool);
    },
    registerService: () => {},
    session: {
      workflow: {
        enqueueNextTurnInjection: async (injection) => ({
          enqueued: true,
          id: "inj-1",
          sessionKey: injection.sessionKey,
        }),
      },
    },
  };
  registerHerdrTools(api, runtime);
  return tools;
}

async function runTool(tools: Map<string, HostTool>, name: string, params: unknown): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`the plugin registered no ${name} tool`);
  const result = await tool.execute("call-1", params);
  return result.content.map((part) => part.text).join("\n");
}

beforeEach(async () => {
  local = await startFakeHerdr("herdr-mm-local-", { agents: LOCAL_AGENTS, readText: "local pane output\n" });
  buildbox = await startFakeHerdr("herdr-mm-buildbox-", { agents: BUILDBOX_AGENTS, readText: "buildbox pane output\n" });
  lab = await startFakeHerdr("herdr-mm-lab-", { agents: LAB_AGENTS, readText: "lab pane output\n" });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-mm-state-"));
  argvFile = path.join(dir, "argv.jsonl");
  callsFile = path.join(dir, "calls.jsonl");
  pidFile = path.join(dir, "pids.tsv");
  logs = [];
  notified = [];
  clock = Date.parse("2026-09-20T12:00:00.000Z");
  process.env.FAKE_SSH_ARGV_FILE = argvFile;
  process.env.FAKE_HERDR_CALLS = callsFile;
  process.env.FAKE_SSH_PID_FILE = pidFile;
  process.env.FAKE_SSH_SOCKET_MAP = JSON.stringify({
    [BUILDBOX_TARGET]: { socket: buildbox.socketPath, status: BUILDBOX_SOCKET },
    [LAB_TARGET]: { socket: lab.socketPath, status: LAB_SOCKET },
  });
  // No single-socket fallback: an unmapped target must fail, not guess.
  delete process.env.FAKE_HERDR_SOCKET;
});

afterEach(async () => {
  for (const runtime of started) await runtime.stop();
  started.length = 0;
  for (const key of [
    "FAKE_SSH_ARGV_FILE",
    "FAKE_HERDR_CALLS",
    "FAKE_SSH_PID_FILE",
    "FAKE_SSH_SOCKET_MAP",
    "FAKE_SSH_FAIL",
    "FAKE_SSH_FAIL_TARGETS",
    "FAKE_SSH_DIE_ON_EOF",
    "FAKE_HERDR_MODE",
  ]) {
    delete process.env[key];
  }
  await Promise.all([local.close(), buildbox.close(), lab.close()]);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("multi-machine resolution", () => {
  it("groups every machine with copyable refs and leaves this host unqualified", async () => {
    const { runtime } = await makeRuntime();
    const out = await runtime.handleCommand("list", {});
    expect(out.split("\n")[0]).toBe("Herdr agents:");
    expect(out.indexOf("Machine buildbox:")).toBeLessThan(out.indexOf("Machine lab:"));

    const here = section(out, "Herdr agents:");
    expect(here).toContain("**w1:p1** claude · idle — local task");
    expect(here).not.toContain("@");

    const there = section(out, "Machine buildbox:");
    expect(there).toContain("**w1:p1@buildbox** reviewer (claude) · idle — buildbox task");
    expect(there).toContain("**w1:p3@buildbox** builder (claude) · idle");
    expect(there).not.toContain("lab task");

    const elsewhere = section(out, "Machine lab:");
    expect(elsewhere).toContain("**w1:p1@lab** builder (codex) · idle — lab task");
    expect(elsewhere).not.toContain("buildbox task");
  });

  it("resolves the same pane id independently on each of the three servers", async () => {
    const { runtime } = await makeRuntime();
    const here = await runtime.handleCommand("status w1:p1", {});
    expect(here).toContain("**w1:p1** claude · idle — local task");
    expect(here).toContain("local pane output");
    expect(here).not.toContain("buildbox");

    const there = await runtime.handleCommand("status w1:p1@buildbox", {});
    expect(there).toContain("**w1:p1@buildbox** reviewer (claude)");
    expect(there).toContain("buildbox pane output");
    expect(there).not.toContain("local pane output");

    const elsewhere = await runtime.handleCommand("status w1:p1@lab", {});
    expect(elsewhere).toContain("**w1:p1@lab** builder (codex)");
    expect(elsewhere).toContain("lab pane output");

    // `read` is scoped the same way, and answers with that machine's pane.
    expect(await runtime.handleCommand("read w1:p1@lab 5", {})).toBe("```\nlab pane output\n```");
    expect(await runtime.handleCommand("read w1:p1@buildbox", {})).toBe("```\nbuildbox pane output\n```");
    expect(await runtime.handleCommand("read w1:p1", {})).toBe("```\nlocal pane output\n```");
  });

  it("refuses an agent name that is ambiguous on one machine, and names that machine", async () => {
    const { runtime } = await makeRuntime();
    const out = await runtime.handleCommand("status reviewer@buildbox", {});
    expect(out).toContain("On buildbox:");
    expect(out).toContain("matches 2 agents by agent name");
    expect(out).toContain("w1:p1 (reviewer)");
    expect(out).toContain("w1:p2 (reviewer)");
    // Ambiguity is refused, not guessed: no pane output is shown at all.
    expect(out).not.toContain("buildbox pane output");
  });

  it("resolves the same agent name on two machines separately, and never across them", async () => {
    const { runtime } = await makeRuntime();
    expect(await runtime.handleCommand("status builder@buildbox", {})).toContain("**w1:p3@buildbox**");
    expect(await runtime.handleCommand("status builder@lab", {})).toContain("**w1:p1@lab**");

    // Without a suffix the herd searched is this host's, only. `builder` runs
    // on both machines and on neither is it offered as a candidate here.
    const bare = await runtime.handleCommand("status builder", {});
    expect(bare).toContain("No agent matches builder");
    expect(bare).toContain("w1:p1 (claude)");
    expect(bare).not.toContain("@buildbox");
    expect(bare).not.toContain("w1:p3");

    // Same for a prompt: nothing is typed anywhere, on any server.
    const sent = await runtime.handleCommand("builder: run the tests", { sessionKey: "s1" });
    expect(sent).toContain("No agent matches builder");
    expect(local.prompts).toEqual([]);
    expect(buildbox.prompts).toEqual([]);
    expect(lab.prompts).toEqual([]);
  });

  it("lists the servers it knows for an unknown machine suffix", async () => {
    const { runtime } = await makeRuntime();
    for (const command of ["status w1:p1@nowhere", "read w1:p1@nowhere", "watch w1:p1@nowhere", "unwatch w1:p1@nowhere"]) {
      const out = await runtime.handleCommand(command, { sessionKey: "s1" });
      expect(out).toContain('"nowhere"');
      expect(out).toContain("local");
      expect(out).toContain("buildbox");
      expect(out).toContain("lab");
    }
    const sent = await runtime.handleCommand("w1:p1@nowhere: run the tests", { sessionKey: "s1" });
    expect(sent).toContain('"nowhere"');
    expect(local.prompts).toEqual([]);
    expect(buildbox.prompts).toEqual([]);
  });
});

describe("allowSend through both surfaces", () => {
  it("refuses a remote prompt from the herdr_send tool and types nothing anywhere", async () => {
    const { runtime } = await makeRuntime();
    const tools = toolsOf(runtime, { sessionKey: "s1", agentId: "main" });
    const refused = await runTool(tools, "herdr_send", { target: "w1:p1@buildbox", text: "run the tests" });
    expect(refused).toContain("**w1:p1@buildbox**");
    expect(refused).toContain("read-only");
    expect(refused).toContain("remote.allowSend");
    expect(buildbox.prompts).toEqual([]);
    // Least of all on the local pane that shares the id.
    expect(local.prompts).toEqual([]);
    expect(notified).toEqual([]);

    // The same tool call does reach this host, so the refusal is about the machine.
    const sent = await runTool(tools, "herdr_send", { target: "w1:p1", text: "run the tests", watch: false });
    expect(sent).toContain("Sent to **w1:p1**");
    expect(local.prompts).toEqual([{ target: "w1:p1", text: "run the tests" }]);
    expect(buildbox.prompts).toEqual([]);
  });

  it("allows a remote prompt from the tool once the machine's id is in allowSend", async () => {
    const { runtime } = await makeRuntime({ allowSend: [BUILDBOX_ID] });
    const tools = toolsOf(runtime, { sessionKey: "s1" });
    const out = await runTool(tools, "herdr_send", { target: "w1:p1@buildbox", text: "run the tests" });
    expect(out).toContain("Sent to **w1:p1@buildbox**");
    expect(buildbox.prompts).toEqual([{ target: "w1:p1", text: "run the tests" }]);
    expect(local.prompts).toEqual([]);
    expect(lab.prompts).toEqual([]);

    // allowSend is per machine: lab is still read-only through the same tool.
    expect(await runTool(tools, "herdr_send", { target: "w1:p1@lab", text: "run the tests" })).toContain("read-only");
    expect(lab.prompts).toEqual([]);
  });

  it("carries the qualified ref through every other tool", async () => {
    const { runtime } = await makeRuntime();
    const tools = toolsOf(runtime, { sessionKey: "s1" });
    expect([...tools.keys()].sort()).toEqual([
      "herdr_list",
      "herdr_read",
      "herdr_send",
      "herdr_start",
      "herdr_status",
      "herdr_watch",
    ]);
    const list = await runTool(tools, "herdr_list", {});
    expect(list).toContain("**w1:p1@buildbox**");
    expect(list).toContain("**w1:p1@lab**");
    expect(await runTool(tools, "herdr_status", { target: "w1:p1@lab" })).toContain("**w1:p1@lab**");
    expect(await runTool(tools, "herdr_read", { target: "w1:p1@buildbox", lines: 5 })).toContain("buildbox pane output");
    expect(await runTool(tools, "herdr_watch", { target: "w1:p1@lab" })).toContain("Watching w1:p1@lab");
    expect(section(await runTool(tools, "herdr_list", {}), "Machine lab:")).toContain("watching");
    expect(section(await runTool(tools, "herdr_list", {}), "Machine buildbox:")).not.toContain("watching");
  });
});

describe("ssh recovery", () => {
  it(
    "reconnects and reconciles after the ssh child is killed, notifying exactly once",
    async () => {
      const { runtime } = await makeRuntime({ allowSend: ["buildbox"] });
      expect(await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" })).toContain(
        "Sent to **w1:p1@buildbox**",
      );
      expect(buildbox.subscribes).toEqual(["w1:p1"]);

      // The transport really is an ssh child process: kill the live ones for
      // buildbox (the subscription, plus any request child still draining).
      const pids = await liveSshPids(BUILDBOX_TARGET);
      expect(pids.length).toBeGreaterThanOrEqual(1);
      expect(await liveSshPids(LAB_TARGET)).toEqual([]);
      // A request child (e.g. the agent.get that followed the prompt) may exit
      // between the liveness probe and the kill: that is not a failure.
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }

      // The task finishes inside the blind window, so only a reconcile after
      // the resubscribe can find it: no event will ever report it.
      buildbox.setAgent("w1:p1", { agent_status: "done", state_change_seq: 9 });

      await waitFor(() => notified.length > 0, 14_000);
      expect(notified).toHaveLength(1);
      expect(notified[0]?.status).toBe("done");
      expect(notified[0]?.session).toBe("s1");
      expect(notified[0]?.text).toContain("**w1:p1@buildbox**");
      expect(notified[0]?.text).toContain("buildbox pane output");
      expect(notified[0]?.text).not.toContain("local pane output");
      expect(buildbox.subscribes).toEqual(["w1:p1", "w1:p1"]);
      // The drop was seen as this machine's transport failing, and nothing else.
      expect(logs.some((line) => line.includes("w1:p1@buildbox") && /SIGKILL|dropped/u.test(line))).toBe(true);
      expect(lab.subscribes).toEqual([]);

      // And it stays exactly one: the watch is gone, nothing settles twice.
      await delay(400);
      expect(notified).toHaveLength(1);
      expect(await runtime.handleCommand("unwatch w1:p1@buildbox", { sessionKey: "s1" })).toContain(
        "was not being watched",
      );
    },
    20_000,
  );

  it(
    "reconnects after the remote end closes the subscription, and notifies once",
    async () => {
      const { runtime } = await makeRuntime({ allowSend: ["buildbox"] });
      await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
      expect(buildbox.subscribes).toEqual(["w1:p1"]);

      // A clean close from the remote side (a Herdr restart), not an ssh error.
      buildbox.dropStreams();
      buildbox.setAgent("w1:p1", { agent_status: "idle", state_change_seq: 12 });

      await waitFor(() => notified.length > 0, 14_000);
      expect(notified).toHaveLength(1);
      expect(notified[0]?.status).toBe("idle");
      expect(notified[0]?.text).toContain("**w1:p1@buildbox**");
      expect(logs.some((line) => line.includes("w1:p1@buildbox") && line.includes("resubscribing"))).toBe(true);
      await delay(400);
      expect(notified).toHaveLength(1);
    },
    20_000,
  );

  it(
    "does not resurrect a watch that was unwatched during the reconnect backoff",
    async () => {
      const { runtime } = await makeRuntime({ allowSend: ["buildbox"] });
      await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
      buildbox.dropStreams();
      expect(await runtime.handleCommand("unwatch w1:p1@buildbox", { sessionKey: "s1" })).toBe(
        "Stopped watching w1:p1@buildbox.",
      );
      // Whatever the pane does now is nobody's business any more.
      buildbox.setAgent("w1:p1", { agent_status: "done", state_change_seq: 9 });
      await delay(4_000);
      expect(notified).toEqual([]);
      expect(buildbox.subscribes).toEqual(["w1:p1"]);
    },
    20_000,
  );
});

describe("machine health", () => {
  it("shows one machine down while the other works, keeps its watch pending, then recovers", async () => {
    const { runtime, registry } = await makeRuntime({ allowSend: ["buildbox"] });
    await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
    const resolutionsBefore = await socketResolutions();

    // Only buildbox stops answering ssh; the live subscription is untouched.
    process.env.FAKE_SSH_FAIL = "auth";
    process.env.FAKE_SSH_FAIL_TARGETS = BUILDBOX_TARGET;
    clock += 60_000; // past the health TTL, so the list really probes again

    const down = await runtime.handleCommand("list", {});
    expect(down).toMatch(/Machine buildbox: down — .*authentication failed/u);
    expect(section(down, "Machine lab:")).toContain("**w1:p1@lab** builder (codex)");
    expect(down).not.toContain("Machine lab: down");
    expect(registry.health(BUILDBOX_ID)?.ok).toBe(false);
    expect(registry.health(LAB_ID)).toEqual({ ok: true });

    // The watch stays pending: no settle, no notification, nothing guessed.
    expect(notified).toEqual([]);
    expect(await runtime.handleCommand("status w1:p1@buildbox", {})).toContain("I cannot reach buildbox");
    expect(await runtime.handleCommand("status w1:p1", {})).toContain("local pane output");

    // It answers again.
    delete process.env.FAKE_SSH_FAIL;
    delete process.env.FAKE_SSH_FAIL_TARGETS;
    clock += 60_000;
    const up = await runtime.handleCommand("list", {});
    expect(section(up, "Machine buildbox:")).toContain("**w1:p1@buildbox** reviewer (claude)");
    expect(section(up, "Machine buildbox:")).toContain("watching");
    // A machine that went down dropped its client, so the socket path was
    // resolved again rather than a stale client being reused.
    expect(await socketResolutions()).toBeGreaterThan(resolutionsBefore);

    // And the watch that waited through it all still settles, exactly once.
    buildbox.setAgent("w1:p1", { agent_status: "done", state_change_seq: 9 });
    buildbox.emit("w1:p1", "done");
    await waitFor(() => notified.length > 0);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.status).toBe("done");
    expect(notified[0]?.text).toContain("**w1:p1@buildbox**");
  });

  it("keeps a machine that answers and refuses out of the health verdict", async () => {
    const { runtime, registry } = await makeRuntime();
    // Herdr is up on buildbox but knows no agents there: it answers `ping` and
    // then an empty herd, which says nothing bad about the machine.
    buildbox.setAgents([]);
    clock += 60_000;
    const out = await runtime.handleCommand("list", {});
    expect(section(out, "Machine buildbox:")).toBe("no agent there");
    expect(out).not.toContain("Machine buildbox: down");
    expect(registry.health(BUILDBOX_ID)).toEqual({ ok: true });
    expect(await runtime.handleCommand("status w1:p1@buildbox", {})).toContain("On buildbox:");
    expect(registry.health(BUILDBOX_ID)).toEqual({ ok: true });
  });

  it("does not condemn a machine whose Herdr answers agent.list with a refusal", async () => {
    const { runtime, registry } = await makeRuntime({ allowSend: ["buildbox"] });
    await runtime.handleCommand("w1:p1@buildbox: run the tests", { sessionKey: "s1" });
    // Herdr is up there and refuses the call: a Herdr problem, not a machine
    // that is down - marking it down would push its watches into backoff.
    buildbox.setListError({ code: "invalid_request", message: "agent.list is not available" });
    clock += 60_000;
    const out = await runtime.handleCommand("list", {});
    expect(out).toContain("Machine buildbox: down — agent.list is not available");
    // No health verdict was recorded, and - the race-free half of the same
    // fact - the machine's client was not dropped either: `reportFailure` does
    // both, synchronously, and neither happened here.
    expect(registry.health(BUILDBOX_ID)).toEqual({ ok: true });
    expect(registry.clientFor(BUILDBOX_ID)).toBeDefined();

    // The watch never noticed, and still settles from its own subscription.
    buildbox.setAgent("w1:p1", { agent_status: "done", state_change_seq: 9 });
    buildbox.emit("w1:p1", "done");
    await waitFor(() => notified.length > 0);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.text).toContain("**w1:p1@buildbox**");
  });
});

describe("stored watches across machines", () => {
  it("adopts a pre-2.5 record as local and keeps a remote one on its machine", async () => {
    const stored = (overrides: Record<string, unknown>) => ({
      terminalId: "term_local",
      agentLabel: "claude",
      sessionKey: "s1",
      promptPreview: "run the tests",
      createdAt: "2026-09-20T11:00:00.000Z",
      deadlineAt: "2026-09-21T11:00:00.000Z",
      lastStatus: "working",
      ...overrides,
    });
    await fs.writeFile(
      path.join(dir, "watches.json"),
      JSON.stringify({
        version: 1,
        watches: [
          // Written before the plugin knew about machines: no serverId at all.
          stored({ id: "pre-2-5", paneId: "w1:p1", seqAtStart: 5 }),
          stored({ id: "remote-one", serverId: BUILDBOX_ID, paneId: "w1:p1", terminalId: "term_b1", seqAtStart: 3 }),
        ],
      }),
      "utf8",
    );
    const { runtime } = await makeRuntime();
    clock += 60_000;
    const out = await runtime.handleCommand("list", {});
    // The migrated record watches this host's pane, the other one buildbox's.
    expect(section(out, "Herdr agents:")).toContain("watching");
    expect(section(out, "Machine buildbox:")).toContain("watching");
    expect(section(out, "Machine lab:")).not.toContain("watching");
    // Neither settles on load: nothing proves either task ran.
    expect(notified).toEqual([]);

    // `unwatch` is scoped by server, in both directions.
    expect(await runtime.handleCommand("unwatch w1:p1", { sessionKey: "s1" })).toBe("Stopped watching w1:p1.");
    expect(await runtime.handleCommand("unwatch w1:p1", { sessionKey: "s1" })).toContain("was not being watched");
    expect(section(await runtime.handleCommand("list", {}), "Machine buildbox:")).toContain("watching");
    expect(await runtime.handleCommand("unwatch w1:p1@buildbox", { sessionKey: "s1" })).toBe(
      "Stopped watching w1:p1@buildbox.",
    );
    expect(section(await runtime.handleCommand("list", {}), "Machine buildbox:")).not.toContain("watching");
  });

  it("watches the same pane id on two machines at once and settles each on its own", async () => {
    const { runtime } = await makeRuntime();
    expect(await runtime.handleCommand("watch w1:p1@buildbox", { sessionKey: "s1" })).toContain(
      "Watching w1:p1@buildbox",
    );
    expect(await runtime.handleCommand("watch w1:p1@lab", { sessionKey: "s1" })).toContain("Watching w1:p1@lab");
    expect(await runtime.handleCommand("watch w1:p1", { sessionKey: "s1" })).toContain("Watching w1:p1");

    // Only lab's pane finishes.
    lab.setAgent("w1:p1", { agent_status: "done", state_change_seq: 11 });
    lab.emit("w1:p1", "working");
    lab.emit("w1:p1", "done");
    await waitFor(() => notified.length > 0);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.text).toContain("**w1:p1@lab**");
    expect(notified[0]?.text).toContain("lab pane output");

    // The two other panes with the same id are still watched, untouched.
    const out = await runtime.handleCommand("list", {});
    expect(section(out, "Herdr agents:")).toContain("watching");
    expect(section(out, "Machine buildbox:")).toContain("watching");
    expect(section(out, "Machine lab:")).not.toContain("watching");
  });
});

describe("test isolation", () => {
  it("only ever spawns the fake ssh and the fake herdr, against the fake machines", async () => {
    const { runtime, registry } = await makeRuntime();
    await runtime.handleCommand("list", {});
    await runtime.handleCommand("status w1:p1@lab", {});

    const argv = await argvLines();
    expect(argv.length).toBeGreaterThan(0);
    for (const line of argv) {
      // Our own fixed option block, so this really is the plugin's argv…
      expect(line).toContain("BatchMode=yes");
      // …and it only ever named one of the two fake machines.
      expect([BUILDBOX_TARGET, LAB_TARGET]).toContain(line.at(-2));
    }
    const calls = await herdrCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toEqual(["machine", "list", "--json"]);
    // The remote sockets are the ones the fake machines reported, not this host's.
    expect((await registry.client(BUILDBOX_ID)).socketPath).toBe(BUILDBOX_SOCKET);
    expect((await registry.client(LAB_ID)).socketPath).toBe(LAB_SOCKET);
    expect(local.socketPath).not.toBe(BUILDBOX_SOCKET);
    // Every ssh the plugin spawned was our fixture: it is what wrote this file.
    expect((await fs.readFile(pidFile, "utf8")).length).toBeGreaterThan(0);
  });
});
