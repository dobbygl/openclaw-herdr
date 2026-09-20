import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_SERVER_ID, ServerRegistry, shortReason } from "../src/core/servers.js";
import { HerdrClient } from "../src/herdr/client.js";
import { type FakeHerdr, startFakeHerdr } from "./fixtures/fake-herdr-server.js";

/**
 * The registry over the fake CLIs only: a fake `herdr` for `machine list
 * --json` and a fake `ssh` that proxies to a fake Herdr server. Nothing here
 * contacts a real machine.
 */
const FAKE_HERDR = fileURLToPath(new URL("./fixtures/fake-herdr-cli.mjs", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
/** What the fake `herdr status server` reports as the remote socket. */
const REMOTE_SOCKET = "/home/alice/.config/herdr/herdr.sock";
const BUILDBOX_ID = "abc123def4567890";
const LAB_ID = "ddd444";

let herdr: FakeHerdr;
let dir: string;
let callsFile: string;
let argvFile: string;
let logs: string[];

function registry(overrides: Record<string, unknown> = {}): ServerRegistry {
  return new ServerRegistry({
    herdrBin: FAKE_HERDR,
    sshBin: FAKE_SSH,
    stateDir: dir,
    localClient: new HerdrClient({ socketPath: herdr.socketPath, requestTimeoutMs: 2_000 }),
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...overrides,
  });
}

async function argvLines(): Promise<string[][]> {
  try {
    const text = await fs.readFile(argvFile, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function herdrCalls(): Promise<number> {
  try {
    return (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  herdr = await startFakeHerdr("herdr-servers-");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-registry-"));
  callsFile = path.join(dir, "calls.jsonl");
  argvFile = path.join(dir, "argv.jsonl");
  logs = [];
  process.env.FAKE_HERDR_CALLS = callsFile;
  process.env.FAKE_SSH_ARGV_FILE = argvFile;
  process.env.FAKE_HERDR_SOCKET = herdr.socketPath;
});

afterEach(async () => {
  delete process.env.FAKE_HERDR_CALLS;
  delete process.env.FAKE_SSH_ARGV_FILE;
  delete process.env.FAKE_HERDR_SOCKET;
  delete process.env.FAKE_SSH_FAIL;
  await herdr.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ServerRegistry discovery", () => {
  it("lists local first, then every enabled machine", async () => {
    const servers = await registry().servers();
    expect(servers).toEqual([
      { id: LOCAL_SERVER_ID, label: "local", isLocal: true },
      { id: BUILDBOX_ID, label: "buildbox", isLocal: false },
      { id: LAB_ID, label: "lab", isLocal: false },
    ]);
  });

  it("resolves a machine by label and by id, and local by default", async () => {
    const servers = registry();
    expect(await servers.resolve()).toEqual({ ok: true, server: { id: "local", label: "local", isLocal: true } });
    expect(await servers.resolve("local")).toEqual({
      ok: true,
      server: { id: "local", label: "local", isLocal: true },
    });
    const byLabel = await servers.resolve("buildbox");
    expect(byLabel.ok && byLabel.server.id).toBe(BUILDBOX_ID);
    const byId = await servers.resolve(LAB_ID);
    expect(byId.ok && byId.server.label).toBe("lab");
    // Labels are case-sensitive, as Herdr stores them.
    expect((await servers.resolve("Buildbox")).ok).toBe(false);
  });

  it("lists the known servers when the suffix matches nothing", async () => {
    const outcome = await registry().resolve("unknown");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('"unknown"');
    expect(outcome.message).toContain("local");
    expect(outcome.message).toContain("buildbox");
    expect(outcome.message).toContain("lab");
  });

  it("spawns nothing and knows only local when remote machines are disabled", async () => {
    const servers = registry({ remoteEnabled: false });
    expect(servers.remoteEnabled).toBe(false);
    expect(await servers.servers()).toEqual([{ id: LOCAL_SERVER_ID, label: "local", isLocal: true }]);
    const outcome = await servers.resolve("buildbox");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("disabled");
    expect(await herdrCalls()).toBe(0);
    expect(await argvLines()).toEqual([]);
  });

  it("keeps the previous machines when the herdr CLI fails, and says why", async () => {
    const servers = registry();
    expect(await servers.servers()).toHaveLength(3);
    process.env.FAKE_HERDR_MODE = "fail";
    try {
      expect(await servers.servers({ refresh: true })).toHaveLength(3);
      expect(servers.catalogError()).toContain("no machines configured");
    } finally {
      delete process.env.FAKE_HERDR_MODE;
    }
  });
});

describe("ServerRegistry clients", () => {
  it("builds one lazy client per machine over ssh, with a ControlPath in the state dir", async () => {
    const servers = registry();
    await servers.prepare();
    const sshDir = path.join(dir, "ssh");
    const stat = await fs.stat(sshDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    expect(servers.clientFor(BUILDBOX_ID)).toBeUndefined();
    const client = await servers.client(BUILDBOX_ID);
    expect(client.socketPath).toBe(REMOTE_SOCKET);
    // Now synchronous, which is what the watcher relies on.
    expect(servers.clientFor(BUILDBOX_ID)).toBe(client);
    // The local client is there from the start and is never rebuilt.
    expect(servers.clientFor(LOCAL_SERVER_ID)).toBe(servers.localClient);

    const pong = await client.ping();
    expect(pong.protocol).toBe(22);
    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.pane_id)).toEqual(["w1:p1", "w1:p2"]);

    const argv = await argvLines();
    expect(argv.length).toBeGreaterThanOrEqual(2);
    const controlPaths = argv.flat().filter((item) => item.startsWith("ControlPath="));
    expect(controlPaths.every((item) => item === `ControlPath=${path.join(sshDir, `${BUILDBOX_ID}.sock`)}`)).toBe(true);
    // The remote socket path is only resolved once, not per request.
    expect(argv.filter((line) => line.some((item) => item.includes("status server")))).toHaveLength(1);
  });

  it("gives a remote client room for a cold ssh and a slow subscription ack", async () => {
    const client = await registry().client(BUILDBOX_ID);
    expect(client.requestTimeoutMs).toBe(15_000);
    expect(client.subscribeAckTimeoutMs).toBe(15_000);
  });

  it("does not cache a client that could not be built", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    const servers = registry();
    await expect(servers.client(BUILDBOX_ID)).rejects.toThrow(/Permission denied|denied/u);
    delete process.env.FAKE_SSH_FAIL;
    const client = await servers.client(BUILDBOX_ID);
    expect(client.socketPath).toBe(REMOTE_SOCKET);
  });
});

describe("ServerRegistry health", () => {
  it("pings a machine, caches the answer and reports a failure in a few words", async () => {
    const servers = registry({ healthTtlMs: 60_000 });
    expect(await servers.ping(BUILDBOX_ID)).toEqual({ ok: true });
    expect(servers.health(BUILDBOX_ID)).toEqual({ ok: true });
    // Cached: no second probe even though ssh would now fail.
    process.env.FAKE_SSH_FAIL = "auth";
    expect(await servers.ping(BUILDBOX_ID)).toEqual({ ok: true });
    const down = await servers.ping(BUILDBOX_ID, { refresh: true });
    expect(down.ok).toBe(false);
    expect(down.reason).toBe("ssh authentication failed");
    // A failed probe drops the client, so the socket path is resolved again.
    expect(servers.clientFor(BUILDBOX_ID)).toBeUndefined();
  });

  it("marks a machine down when someone else notices it failing", async () => {
    const servers = registry();
    await servers.client(BUILDBOX_ID);
    servers.reportFailure(BUILDBOX_ID, "Herdr subscription error: ssh to buildbox: the ssh connection dropped");
    expect(servers.health(BUILDBOX_ID)).toEqual({ ok: false, reason: "the ssh connection dropped" });
    expect(servers.clientFor(BUILDBOX_ID)).toBeUndefined();
    // Local is never marked down: its failures are reported as they happen.
    servers.reportFailure(LOCAL_SERVER_ID, "whatever");
    expect(servers.health(LOCAL_SERVER_ID)).toBeUndefined();
  });
});

describe("ServerRegistry policy", () => {
  it("allows sending only to local and to the machines in allowSend", async () => {
    const byLabel = registry({ allowSend: ["buildbox"] });
    await byLabel.servers();
    expect(byLabel.allowsSend(LOCAL_SERVER_ID)).toBe(true);
    expect(byLabel.allowsSend(BUILDBOX_ID)).toBe(true);
    expect(byLabel.allowsSend(LAB_ID)).toBe(false);

    const byId = registry({ allowSend: [LAB_ID] });
    await byId.servers();
    expect(byId.allowsSend(LAB_ID)).toBe(true);
    expect(byId.allowsSend(BUILDBOX_ID)).toBe(false);

    const none = registry();
    await none.servers();
    expect(none.allowsSend(BUILDBOX_ID)).toBe(false);
  });

  it("describes a machine by label, and falls back to the id it no longer knows", async () => {
    const servers = registry();
    await servers.servers();
    expect(servers.describe(BUILDBOX_ID)).toEqual({ id: BUILDBOX_ID, label: "buildbox", isLocal: false });
    expect(servers.suffix(BUILDBOX_ID)).toBe("buildbox");
    expect(servers.suffix(LOCAL_SERVER_ID)).toBeUndefined();
    expect(servers.describe("gone999")).toEqual({ id: "gone999", label: "gone999", isLocal: false });
  });
});

describe("shortReason", () => {
  it("keeps the last, actionable segment and bounds it", () => {
    expect(shortReason("Herdr socket error for ping: ssh to alice@lab: ssh authentication failed")).toBe(
      "ssh authentication failed",
    );
    expect(shortReason("ENOENT")).toBe("ENOENT");
    expect(shortReason("x".repeat(200))).toHaveLength(80);
  });
});
