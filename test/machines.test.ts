import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HerdrTransportError } from "../src/herdr/client.js";
import {
  DEFAULT_MACHINE_LIST_TTL_MS,
  DEFAULT_SOCKET_PATH_TTL_MS,
  MachineCatalog,
  TtlCache,
  listMachines,
  normalizeMachine,
  parseSocketLine,
  resolveRemoteSocketPath,
} from "../src/herdr/machines.js";

/** Fake CLIs only: nothing in this file contacts a real machine. */
const FAKE_HERDR = fileURLToPath(new URL("./fixtures/fake-herdr-cli.mjs", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));

const BUILDBOX = { id: "abc123def4567890", label: "buildbox", target: "buildbox", session: "default", enabled: true };
const LAB = { id: "ddd444", label: "lab", target: "alice@lab", session: "work", enabled: true };

let dir: string;
let callsFile: string;
let argvFile: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-machines-"));
  callsFile = path.join(dir, "calls.jsonl");
  argvFile = path.join(dir, "argv.jsonl");
  process.env.FAKE_HERDR_CALLS = callsFile;
  process.env.FAKE_SSH_ARGV_FILE = argvFile;
});

afterEach(async () => {
  delete process.env.FAKE_HERDR_MODE;
  delete process.env.FAKE_SSH_FAIL;
  delete process.env.FAKE_SSH_STATUS_SOCKET;
  await fs.rm(callsFile, { force: true });
  await fs.rm(argvFile, { force: true });
});

afterAll(async () => {
  delete process.env.FAKE_HERDR_CALLS;
  delete process.env.FAKE_SSH_ARGV_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

async function calls(): Promise<number> {
  try {
    return (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function argvLines(): Promise<string[][]> {
  const text = await fs.readFile(argvFile, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe("normalizeMachine", () => {
  it("keeps the fields we use and drops the rest", () => {
    expect(
      normalizeMachine({ id: "a1", label: "buildbox", target: "buildbox", session: "default", enabled: true, selected: false, future: 1 }),
    ).toEqual({ id: "a1", label: "buildbox", target: "buildbox", session: "default", enabled: true });
  });

  it("treats a missing `enabled` as enabled, per the ignore-unknown-fields rule", () => {
    expect(normalizeMachine({ id: "a1", label: "l", target: "t" })?.enabled).toBe(true);
    expect(normalizeMachine({ id: "a1", label: "l", target: "t", enabled: false })?.enabled).toBe(false);
  });

  it("omits an empty session instead of storing one", () => {
    expect(normalizeMachine({ id: "a1", label: "l", target: "t", session: "  " })).not.toHaveProperty("session");
  });

  it("drops rows we could not address later", () => {
    for (const bad of [
      undefined,
      "not-a-machine",
      42,
      [],
      { label: "l", target: "t" },
      { id: "a", target: "t" },
      { id: "a", label: "l" },
      { id: "a", label: "l", target: "" },
      { id: "a", label: "l", target: "-oProxyCommand=id" },
      { id: "a", label: "l", target: "box; id" },
    ]) {
      expect(normalizeMachine(bad)).toBeUndefined();
    }
  });
});

describe("listMachines", () => {
  it("returns only enabled, addressable machines in Herdr's order", async () => {
    const machines = await listMachines({ herdrBin: FAKE_HERDR });
    expect(machines).toEqual([BUILDBOX, LAB]);
    expect(await calls()).toBe(1);
  });

  it("accepts a `{ machines: [...] }` envelope too", async () => {
    process.env.FAKE_HERDR_MODE = "wrapped";
    expect(await listMachines({ herdrBin: FAKE_HERDR })).toEqual([BUILDBOX, LAB]);
  });

  it("fails clearly on non-JSON output", async () => {
    process.env.FAKE_HERDR_MODE = "badjson";
    await expect(listMachines({ herdrBin: FAKE_HERDR })).rejects.toThrow(/did not print JSON/u);
  });

  it("fails clearly when the payload is not a list", async () => {
    process.env.FAKE_HERDR_MODE = "notarray";
    await expect(listMachines({ herdrBin: FAKE_HERDR })).rejects.toThrow(/did not print an array of machines/u);
  });

  it("reports a non-zero exit with its first stderr line", async () => {
    process.env.FAKE_HERDR_MODE = "fail";
    await expect(listMachines({ herdrBin: FAKE_HERDR })).rejects.toThrow(
      /failed \(exit 3\): error: no machines configured/u,
    );
  });

  it("kills a hanging herdr and says so", async () => {
    process.env.FAKE_HERDR_MODE = "hang";
    await expect(listMachines({ herdrBin: FAKE_HERDR, timeoutMs: 250 })).rejects.toThrow(/timed out after 250ms/u);
  });

  it("reports a missing herdr binary", async () => {
    await expect(listMachines({ herdrBin: path.join(dir, "no-such-herdr") })).rejects.toBeInstanceOf(
      HerdrTransportError,
    );
  });
});

describe("parseSocketLine", () => {
  it("finds the socket line of `herdr status server`", () => {
    expect(parseSocketLine("herdr 0.9.1\nrunning: true\nsocket: /run/herdr.sock\nprotocol: 22\n")).toBe(
      "/run/herdr.sock",
    );
    expect(parseSocketLine("  Socket :  /run/herdr.sock  ")).toBe("/run/herdr.sock");
  });

  it("returns undefined when there is none", () => {
    expect(parseSocketLine("running: false\n")).toBeUndefined();
    expect(parseSocketLine("")).toBeUndefined();
    // Not a single token: refused here rather than half-parsed.
    expect(parseSocketLine("socket: /run/herdr.sock and then some")).toBeUndefined();
  });
});

describe("resolveRemoteSocketPath", () => {
  it("asks the remote herdr and returns the path", async () => {
    const socketPath = await resolveRemoteSocketPath({ sshBin: FAKE_SSH, target: "alice@buildbox" });
    expect(socketPath).toBe("/home/alice/.config/herdr/herdr.sock");
    const argv = (await argvLines())[0] ?? [];
    expect(argv.at(-2)).toBe("alice@buildbox");
    expect(argv.at(-1)).toBe("herdr status server");
    expect(argv).toContain("BatchMode=yes");
  });

  it("passes a named session and a ControlPath through", async () => {
    process.env.FAKE_SSH_STATUS_SOCKET = "/run/user/1000/herdr/work.sock";
    const socketPath = await resolveRemoteSocketPath({
      sshBin: FAKE_SSH,
      target: "alice@lab",
      session: "work",
      controlPath: path.join(dir, "cm-lab"),
    });
    expect(socketPath).toBe("/run/user/1000/herdr/work.sock");
    const argv = (await argvLines())[0] ?? [];
    expect(argv.at(-1)).toBe("herdr --session work status server");
    expect(argv).toContainEqual(`ControlPath=${path.join(dir, "cm-lab")}`);
  });

  it("refuses a session name that would reach the remote shell", async () => {
    await expect(
      resolveRemoteSocketPath({ sshBin: FAKE_SSH, target: "alice@lab", session: "work; rm -rf /" }),
    ).rejects.toThrow(/session name is not a safe remote argument/u);
  });

  it("fails when the output has no socket line", async () => {
    process.env.FAKE_SSH_FAIL = "no-socket-line";
    await expect(resolveRemoteSocketPath({ sshBin: FAKE_SSH, target: "alice@buildbox" })).rejects.toThrow(
      /printed no "socket:" line/u,
    );
  });

  it("validates the path it parsed, not just the ones we supply", async () => {
    process.env.FAKE_SSH_FAIL = "unsafe-socket-line";
    await expect(resolveRemoteSocketPath({ sshBin: FAKE_SSH, target: "alice@buildbox" })).rejects.toThrow(
      /socket path reported by alice@buildbox contains characters/u,
    );
  });

  it("maps an ssh failure", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    await expect(resolveRemoteSocketPath({ sshBin: FAKE_SSH, target: "alice@buildbox" })).rejects.toThrow(
      /failed \(exit 255\)/u,
    );
  });
});

describe("TtlCache", () => {
  it("expires entries on its own clock", () => {
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => now });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    now += 99;
    expect(cache.get("k")).toBe("v");
    now += 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("forgets on demand", () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("MachineCatalog", () => {
  it("defaults to 30 s for the list and 10 min for socket paths", () => {
    expect(DEFAULT_MACHINE_LIST_TTL_MS).toBe(30_000);
    expect(DEFAULT_SOCKET_PATH_TTL_MS).toBe(600_000);
  });

  it("spawns herdr once per TTL window", async () => {
    let now = 0;
    const catalog = new MachineCatalog({ herdrBin: FAKE_HERDR, listTtlMs: 1_000, now: () => now });
    expect(await catalog.machines()).toEqual([BUILDBOX, LAB]);
    expect(await catalog.machines()).toEqual([BUILDBOX, LAB]);
    expect(await calls()).toBe(1);
    now += 1_000;
    expect(await catalog.machines()).toEqual([BUILDBOX, LAB]);
    expect(await calls()).toBe(2);
  });

  it("collapses a burst into one spawn", async () => {
    const catalog = new MachineCatalog({ herdrBin: FAKE_HERDR });
    const results = await Promise.all([
      catalog.machines(),
      catalog.machines(),
      catalog.machines(),
      catalog.machines(),
      catalog.machines(),
    ]);
    for (const result of results) expect(result).toEqual([BUILDBOX, LAB]);
    expect(await calls()).toBe(1);
  });

  it("refreshes on demand and after invalidate()", async () => {
    const catalog = new MachineCatalog({ herdrBin: FAKE_HERDR });
    await catalog.machines();
    await catalog.machines({ refresh: true });
    expect(await calls()).toBe(2);
    catalog.invalidate();
    await catalog.machines();
    expect(await calls()).toBe(3);
  });

  it("caches a resolved socket path per target and session", async () => {
    const catalog = new MachineCatalog({ sshBin: FAKE_SSH, controlPath: path.join(dir, "cm") });
    expect(await catalog.socketPath(LAB)).toBe("/home/alice/.config/herdr/herdr.sock");
    expect(await catalog.socketPath(LAB)).toBe("/home/alice/.config/herdr/herdr.sock");
    expect(await argvLines()).toHaveLength(1);
    // A different session on the same host is a different socket.
    await catalog.socketPath({ target: LAB.target });
    expect(await argvLines()).toHaveLength(2);
    const [withSession, withoutSession] = await argvLines();
    expect(withSession?.at(-1)).toBe("herdr --session work status server");
    expect(withoutSession?.at(-1)).toBe("herdr status server");
  });

  it("does not cache a failure", async () => {
    process.env.FAKE_SSH_FAIL = "auth";
    const catalog = new MachineCatalog({ sshBin: FAKE_SSH });
    await expect(catalog.socketPath(BUILDBOX)).rejects.toThrow(HerdrTransportError);
    delete process.env.FAKE_SSH_FAIL;
    expect(await catalog.socketPath(BUILDBOX)).toBe("/home/alice/.config/herdr/herdr.sock");
  });
});
