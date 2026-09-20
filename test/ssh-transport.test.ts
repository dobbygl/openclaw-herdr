import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../src/herdr/client.js";
import { buildRemoteCommand, createSshConnectionFactory } from "../src/herdr/ssh-stdio.js";
import { type FakeHerdr, startFakeHerdr } from "./fixtures/fake-herdr-server.js";

/**
 * End-to-end over the transport seam: a fake `ssh` (which ignores every option
 * and proxies stdin/stdout, exactly as `socat - UNIX-CONNECT:…` would) in front
 * of the same fake Herdr server the local socket tests use. Nothing here talks
 * to a real machine.
 */
const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
const REMOTE_SOCKET = "/home/alice/.config/herdr/herdr.sock";

let herdr: FakeHerdr;
let dir: string;
let argvFile: string;

function remoteClient(
  options: { remoteTool?: "socat" | "python"; subscribeAckTimeoutMs?: number; connectTimeoutMs?: number } = {},
): HerdrClient {
  return new HerdrClient({
    socketPath: REMOTE_SOCKET,
    connect: createSshConnectionFactory({
      sshBin: FAKE_SSH,
      target: "alice@buildbox",
      socketPath: REMOTE_SOCKET,
      controlPath: path.join(dir, "cm-buildbox"),
      ...(options.remoteTool ? { remoteTool: options.remoteTool } : {}),
      ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    }),
    requestTimeoutMs: 5_000,
    subscribeAckTimeoutMs: options.subscribeAckTimeoutMs ?? 5_000,
  });
}

/** Is this helper installed on the machine running the tests? */
function available(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Runs a remote command string through `/bin/sh -c`, which is what ssh hands to
 * the remote login shell, and returns the first JSON line it prints. This is
 * the only way to test the *contents* of the helper command (and its quoting)
 * rather than just its shape - against the local fake Herdr socket.
 */
async function firstLineThroughShell(command: string): Promise<string> {
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer in 5s; stderr=${err}`)), 5_000);
      const settle = () => {
        const index = out.indexOf("\n");
        if (index < 0) return false;
        clearTimeout(timer);
        resolve(out.slice(0, index));
        return true;
      };
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        settle();
      });
      child.on("close", () => {
        if (settle()) return;
        clearTimeout(timer);
        reject(new Error(`helper exited without answering; stderr=${err}`));
      });
      child.stdin.write(JSON.stringify({ id: "r1", method: "ping", params: {} }) + "\n");
    });
  } finally {
    child.kill("SIGKILL");
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  herdr = await startFakeHerdr("herdr-ssh-");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-ssh-state-"));
  argvFile = path.join(dir, "argv.jsonl");
  process.env.FAKE_HERDR_SOCKET = herdr.socketPath;
  process.env.FAKE_SSH_ARGV_FILE = argvFile;
});

afterEach(() => {
  delete process.env.FAKE_SSH_FAIL;
  delete process.env.FAKE_SSH_DROP_MS;
});

afterAll(async () => {
  delete process.env.FAKE_HERDR_SOCKET;
  delete process.env.FAKE_SSH_ARGV_FILE;
  await herdr.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function lastArgv(): Promise<string[]> {
  const lines = (await fs.readFile(argvFile, "utf8")).trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "[]") as string[];
}

describe("HerdrClient over ssh stdio", () => {
  it("answers a request and keeps the local behaviour", async () => {
    const client = remoteClient();
    expect(client.socketPath).toBe(REMOTE_SOCKET);
    expect((await client.ping()).protocol).toBe(22);
    expect((await client.readAgent("w1:p1", { lines: 2 })).text).toContain("❯");
    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.pane_id)).toEqual(["w1:p1", "w1:p2"]);
  });

  it("spawns ssh with the multiplexing options and one remote command word", async () => {
    await remoteClient().ping();
    const argv = await lastArgv();
    expect(argv).toContain("ControlMaster=auto");
    expect(argv).toContain("ControlPersist=120");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("-T");
    expect(argv.at(-2)).toBe("alice@buildbox");
    expect(argv.at(-1)).toBe(`socat - UNIX-CONNECT:${REMOTE_SOCKET}`);
  });

  it("can carry the python bridge instead of socat", async () => {
    const client = remoteClient({ remoteTool: "python" });
    expect((await client.ping()).protocol).toBe(22);
    expect(await lastArgv()).toContainEqual(expect.stringContaining("python3 -c '"));
  });

  it("turns a Herdr error response into HerdrRequestError", async () => {
    await expect(remoteClient().request("no.such")).rejects.toBeInstanceOf(HerdrRequestError);
  });

  it("streams a subscription until it is closed", async () => {
    const client = remoteClient();
    const events: string[] = [];
    const subscription = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }], (event) =>
      events.push(`${event.event}:${String(event.data.agent_status)}`),
    );
    await subscription.ready;
    herdr.emit("w1:p1", "working");
    herdr.emit("w1:p1", "done");
    await delay(150);
    subscription.close();
    await subscription.closed;
    expect(events).toEqual(["pane.agent_status_changed:working", "pane.agent_status_changed:done"]);
  });

  it("surfaces a dropped ssh as a closed subscription", async () => {
    process.env.FAKE_SSH_DROP_MS = "400";
    const client = remoteClient();
    const errors: Error[] = [];
    const subscription = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "w1:p2" }],
      () => {},
      (error) => errors.push(error),
    );
    await subscription.ready;
    // No close() from us: the transport dies on its own, which is what the
    // watcher's reconnect-with-backoff path keys on.
    await subscription.closed;
    expect(errors[0]).toBeInstanceOf(HerdrTransportError);
    expect(errors[0]?.message).toMatch(/ssh to alice@buildbox: the ssh connection dropped/u);
  });

  it("maps an ssh auth failure to a short reason", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    await expect(remoteClient().ping()).rejects.toThrow(/ssh authentication failed/u);
  });

  it("maps a host key failure", async () => {
    process.env.FAKE_SSH_FAIL = "hostkey";
    await expect(remoteClient().ping()).rejects.toThrow(/host key verification failed/u);
  });

  it("maps a missing remote socket", async () => {
    process.env.FAKE_SSH_FAIL = "missing-socket";
    await expect(remoteClient().ping()).rejects.toThrow(/remote Herdr socket does not exist/u);
  });

  it("maps a remote host without socat", async () => {
    process.env.FAKE_SSH_FAIL = "no-tool";
    await expect(remoteClient().ping()).rejects.toThrow(/not installed/u);
  });

  it("reports a failing ssh on a subscription through ready and closed", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    const subscription = remoteClient().subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }], () => {});
    await expect(subscription.ready).rejects.toThrow(/ssh authentication failed/u);
    await subscription.closed;
  });

  it("gives up on an ssh that says nothing, when a connect guard is set", async () => {
    // `agent.wait` is never answered by the fake server, so the child stays
    // silent - which is exactly what the (opt-in) guard is for.
    const client = remoteClient({ connectTimeoutMs: 200 });
    await expect(client.waitFor("w1:p1", ["idle"])).rejects.toThrow(/said nothing within 200ms/u);
  });

  it("fails the request when ssh itself cannot be started", async () => {
    const client = new HerdrClient({
      socketPath: REMOTE_SOCKET,
      connect: createSshConnectionFactory({
        sshBin: path.join(dir, "no-such-ssh"),
        target: "alice@buildbox",
        socketPath: REMOTE_SOCKET,
      }),
      requestTimeoutMs: 2_000,
    });
    await expect(client.ping()).rejects.toThrow(/ssh could not be started/u);
  });
});

/**
 * The commands themselves, executed locally through `/bin/sh -c` against the
 * fake Herdr socket. The fake `ssh` ignores the remote command, so without
 * this the python bridge would only ever be string-compared.
 */
describe("remote helper commands", () => {
  it.skipIf(!available("python3"))("the python bridge speaks the protocol", async () => {
    const line = await firstLineThroughShell(buildRemoteCommand("python", herdr.socketPath));
    expect((JSON.parse(line) as { result: { protocol: number } }).result.protocol).toBe(22);
  });

  it.skipIf(!available("socat"))("the socat command speaks the protocol", async () => {
    const line = await firstLineThroughShell(buildRemoteCommand("socat", herdr.socketPath));
    expect((JSON.parse(line) as { result: { protocol: number } }).result.protocol).toBe(22);
  });
});
