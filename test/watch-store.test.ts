import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_SERVER_ID } from "../src/core/servers.js";
import { WatchStore, type WatchInput } from "../src/core/watch-store.js";

/** The local pane every fixture below watches. */
const LOCAL = { serverId: LOCAL_SERVER_ID, paneId: "w1:p1" };

let dir: string;
let logs: string[];
const logger = {
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-store-"));
  logs = [];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function input(overrides: Partial<WatchInput> = {}): WatchInput {
  return {
    paneId: "w1:p1",
    terminalId: "term_1",
    agentLabel: "claude",
    sessionKey: "s1",
    promptPreview: "run the tests",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    seqAtStart: 7,
    lastStatus: "working",
    ...overrides,
  };
}

async function writeFile(contents: string): Promise<void> {
  await fs.writeFile(path.join(dir, "watches.json"), contents, "utf8");
}

async function listDir(): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe("WatchStore", () => {
  it("starts empty when the file does not exist", async () => {
    const store = new WatchStore(dir, logger);
    await store.load();
    expect(store.list()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("refuses to be used before load()", () => {
    const store = new WatchStore(dir, logger);
    expect(() => store.list()).toThrow(/load\(\)/u);
  });

  it("fills the bookkeeping fields on add and keeps one watch per (pane, session)", async () => {
    const store = new WatchStore(dir, logger);
    await store.load();
    const first = await store.add(input());
    expect(first.record.sawWorking).toBe(false);
    expect(first.record.notificationSeq).toBe(0);
    expect(first.replaced).toBeUndefined();

    const other = await store.add(input({ sessionKey: "s2", sawWorking: true }));
    expect(other.replaced).toBeUndefined();
    expect(store.listByPane(LOCAL)).toHaveLength(2);
    expect(other.record.sawWorking).toBe(true);

    const again = await store.add(input({ promptPreview: "second prompt" }));
    expect(again.replaced?.id).toBe(first.record.id);
    expect(store.listByPane(LOCAL).map((w) => w.sessionKey).sort()).toEqual(["s1", "s2"]);
    expect(store.byPaneAndSession(LOCAL, "s1")?.promptPreview).toBe("second prompt");
    expect(store.byId(first.record.id)).toBeUndefined();
  });

  it("patches records and clears the pending delivery with null", async () => {
    const store = new WatchStore(dir, logger);
    await store.load();
    const { record } = await store.add(input());
    expect(
      await store.update(record.id, {
        pendingDelivery: { status: "idle", text: "done", attempts: 1, nextAttemptAt: new Date().toISOString() },
        sawWorking: true,
      }),
    ).toBe(true);
    expect(store.byId(record.id)?.pendingDelivery?.status).toBe("idle");
    await store.update(record.id, { pendingDelivery: null });
    expect(store.byId(record.id)?.pendingDelivery).toBeUndefined();
    expect(store.byId(record.id)?.sawWorking).toBe(true);

    await store.remove(record.id);
    expect(await store.update(record.id, { sawWorking: false })).toBe(false);
    expect(await store.remove(record.id)).toBe(false);
  });

  it("round-trips through the file", async () => {
    const first = new WatchStore(dir, logger);
    await first.load();
    const { record } = await first.add(input({ sawWorking: true }));
    await first.update(record.id, {
      pendingDelivery: { status: "done", text: "finished", attempts: 2, nextAttemptAt: new Date().toISOString() },
      settledStatus: "done",
      notificationSeq: 3,
    });

    const second = new WatchStore(dir, logger);
    await second.load();
    const reloaded = second.byId(record.id);
    expect(reloaded?.sawWorking).toBe(true);
    expect(reloaded?.notificationSeq).toBe(3);
    expect(reloaded?.settledStatus).toBe("done");
    expect(reloaded?.pendingDelivery?.attempts).toBe(2);
    expect(logs).toEqual([]);
  });

  it("keeps the same pane id on two servers apart", async () => {
    const store = new WatchStore(dir, logger);
    await store.load();
    const here = await store.add(input());
    const there = await store.add(input({ serverId: "abc123" }));
    expect(here.replaced).toBeUndefined();
    expect(there.replaced).toBeUndefined();
    expect(here.record.serverId).toBe("local");
    expect(store.list()).toHaveLength(2);
    expect(store.listByPane(LOCAL)).toHaveLength(1);
    expect(store.listByPane({ serverId: "abc123", paneId: "w1:p1" }).map((w) => w.id)).toEqual([there.record.id]);
    expect(store.byPaneAndSession({ serverId: "abc123", paneId: "w1:p1" }, "s1")?.id).toBe(there.record.id);

    // Re-watching the remote pane replaces only the remote watch.
    const again = await store.add(input({ serverId: "abc123", promptPreview: "again" }));
    expect(again.replaced?.id).toBe(there.record.id);
    expect(store.byId(here.record.id)).toBeDefined();
  });

  it("migrates a pre-2.5 record without a server to local", async () => {
    await writeFile(
      JSON.stringify({
        version: 1,
        watches: [
          {
            id: "old-local",
            paneId: "w6:p1",
            terminalId: "term_3",
            agentLabel: "codex",
            sessionKey: "agent:main:telegram:1",
            promptPreview: "p",
            createdAt: "2026-09-19T10:00:00.000Z",
            deadlineAt: "2026-09-20T10:00:00.000Z",
          },
          {
            id: "remote-one",
            serverId: "abc123",
            paneId: "w6:p1",
            terminalId: "term_4",
            agentLabel: "claude",
            sessionKey: "agent:main:telegram:1",
            promptPreview: "p",
            createdAt: "2026-09-19T10:00:00.000Z",
            deadlineAt: "2026-09-20T10:00:00.000Z",
          },
          // An empty server is as good as none: it must not stay unaddressable.
          { id: "blank", serverId: "", paneId: "w6:p2", terminalId: "t", agentLabel: "claude", sessionKey: "s1", promptPreview: "p", createdAt: "2026-09-19T10:00:00.000Z", deadlineAt: "2026-09-20T10:00:00.000Z" },
        ],
      }),
    );
    const store = new WatchStore(dir, logger);
    await store.load();
    expect(store.byId("old-local")?.serverId).toBe("local");
    expect(store.byId("blank")?.serverId).toBe("local");
    expect(store.byId("remote-one")?.serverId).toBe("abc123");
    expect(store.listByPane({ serverId: "local", paneId: "w6:p1" }).map((w) => w.id)).toEqual(["old-local"]);
    expect(logs).toEqual([]);
  });

  it("accepts records written before the new fields existed", async () => {
    await writeFile(
      JSON.stringify({
        version: 1,
        watches: [
          {
            id: "old-1",
            paneId: "w6:p1",
            terminalId: "term_3",
            agentLabel: "codex",
            sessionKey: "agent:main:telegram:1",
            promptPreview: "p",
            createdAt: "2026-09-19T10:00:00.000Z",
            deadlineAt: "2026-09-20T10:00:00.000Z",
            seqAtStart: 4,
            lastStatus: "working",
          },
        ],
      }),
    );
    const store = new WatchStore(dir, logger);
    await store.load();
    const record = store.byId("old-1");
    expect(record?.sawWorking).toBe(false);
    expect(record?.notificationSeq).toBe(0);
    expect(record?.seqAtStart).toBe(4);
    expect(logs).toEqual([]);
  });

  it("skips invalid records and keeps the good ones", async () => {
    const good = {
      id: "good",
      paneId: "w1:p1",
      terminalId: "t",
      agentLabel: "claude",
      sessionKey: "s1",
      promptPreview: "p",
      createdAt: "2026-09-20T10:00:00.000Z",
      deadlineAt: "2026-09-20T22:00:00.000Z",
      sawWorking: true,
      notificationSeq: 1,
    };
    await writeFile(
      JSON.stringify({
        version: 1,
        watches: [
          good,
          "not an object",
          { ...good, id: "" },
          { ...good, id: "no-session", sessionKey: 42 },
          { ...good, id: "bad-date", deadlineAt: "whenever" },
          { ...good, id: "no-created", createdAt: undefined },
          {
            ...good,
            id: "bad-pending",
            pendingDelivery: { status: "explosion", text: "x", attempts: 1, nextAttemptAt: "now" },
          },
          { ...good, id: "bad-seq", seqAtStart: "ten", notificationSeq: -3, sawWorking: "yes" },
        ],
      }),
    );
    const store = new WatchStore(dir, logger);
    await store.load();
    expect(store.list().map((w) => w.id)).toEqual(["good", "bad-pending", "bad-seq"]);
    // An unusable pendingDelivery is dropped, the watch itself survives.
    expect(store.byId("bad-pending")?.pendingDelivery).toBeUndefined();
    const lenient = store.byId("bad-seq");
    expect(lenient?.seqAtStart).toBeUndefined();
    expect(lenient?.notificationSeq).toBe(0);
    expect(lenient?.sawWorking).toBe(false);
    expect(logs.filter((line) => line.includes("skipping record"))).toHaveLength(5);
  });

  it("moves a corrupt file aside and starts empty", async () => {
    await writeFile("{ not json at all");
    const store = new WatchStore(dir, logger);
    await store.load();
    expect(store.list()).toEqual([]);
    const files = await listDir();
    expect(files.some((name) => /^watches\.json\.corrupt-\d+$/u.test(name))).toBe(true);
    expect(files).not.toContain("watches.json");
    expect(logs.some((line) => line.includes("not valid JSON"))).toBe(true);

    // The store is usable afterwards and writes a fresh file.
    await store.add(input());
    expect((await listDir()).includes("watches.json")).toBe(true);
    const reopened = new WatchStore(dir, logger);
    await reopened.load();
    expect(reopened.list()).toHaveLength(1);
  });

  it("moves a file that is not a watch list aside", async () => {
    await writeFile(JSON.stringify({ version: 1, watches: "all of them" }));
    const store = new WatchStore(dir, logger);
    await store.load();
    expect(store.list()).toEqual([]);
    expect((await listDir()).some((name) => name.startsWith("watches.json.corrupt-"))).toBe(true);
    expect(logs.some((line) => line.includes("does not hold a watch list"))).toBe(true);
  });
});
