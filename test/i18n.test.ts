import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError, HerdrTransportError, type Subscription } from "../src/herdr/client.js";
import type { AgentInfo } from "../src/herdr/types.js";
import { formatNotification } from "../src/core/format.js";
import { LANGUAGES, messages, readLanguage, type Language } from "../src/core/i18n.js";
import { helpText, parseHerdrCommand } from "../src/core/parse.js";
import { WatchStore, type WatchRecord } from "../src/core/watch-store.js";
import { readPluginConfig } from "../src/openclaw/config.js";
import { describeFailure, HerdrRuntime } from "../src/openclaw/runtime.js";

const EN = messages("en");
const ES = messages("es");

describe("catalogs", () => {
  it("have the same keys, and every sentence has the same arguments in both", () => {
    expect(Object.keys(ES).sort()).toEqual(Object.keys(EN).sort());
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(typeof ES[key], key).toBe(typeof EN[key]);
      if (typeof EN[key] === "function") expect((ES[key] as () => unknown).length, key).toBe((EN[key] as () => unknown).length);
    }
  });

  it("differ for every plain sentence, so nothing was left untranslated by copy", () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      if (typeof EN[key] === "string") expect(ES[key], key).not.toBe(EN[key]);
    }
  });

  it("interpolate identifiers verbatim", () => {
    const ref = "sample#reviewer@buildbox";
    for (const m of [EN, ES]) {
      expect(m.sentTo("w1:p1@buildbox", "sample#reviewer")).toContain("**w1:p1@buildbox** (sample#reviewer)");
      expect(m.readOnly(ref, "buildbox").join("\n")).toContain(`**${ref}**`);
      expect(m.readOnly(ref, "buildbox").join("\n")).toContain("remote.allowSend");
      expect(m.herdrRefused("tab.list is not allowed", "permission_denied")).toContain("tab.list is not allowed (permission_denied)");
      expect(m.cannotReachMachine("buildbox", "ssh authentication failed")).toContain("ssh authentication failed");
      expect(m.startSendHint("reviewer@buildbox")).toContain("/herdr reviewer@buildbox: <prompt>");
    }
    expect(ES.unwatchedCount("w1:p1", 1)).toBe("Dejé de vigilar w1:p1 (1 vigilancia).");
    expect(ES.unwatchedCount("w1:p1", 2)).toBe("Dejé de vigilar w1:p1 (2 vigilancias).");
  });
});

describe("readLanguage", () => {
  it("is English when absent and exact otherwise", () => {
    expect(readLanguage(undefined)).toEqual({ language: "en" });
    expect(readLanguage("es")).toEqual({ language: "es" });
    expect(readLanguage("es-MX")).toEqual({ language: "en", invalid: '"es-MX"' });
    expect(LANGUAGES).toEqual(["en", "es"]);
  });
});

describe("help and grammar", () => {
  /** The command part of a help line: from `/herdr` to the first ` — `. */
  const commands = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("/herdr"))
      .map((line) => line.split(" — ")[0]);

  it("keeps every command line identical in Spanish", () => {
    expect(commands(helpText(ES))).toEqual(commands(helpText(EN)));
    expect(helpText(ES)).toContain("Comandos de Herdr:");
    expect(helpText(ES)).toContain("w9:p1@buildbox");
  });

  it("parses the same commands whatever the language", () => {
    for (const input of [
      "list",
      "status sample#reviewer@buildbox",
      "read w1:p1 30",
      "watch w1:p1",
      "unwatch reviewer",
      "start reviewer codex ~/project",
      "sample#builder: run the tests",
      "run the tests",
    ]) {
      expect(parseHerdrCommand(ES, input), input).toEqual(parseHerdrCommand(EN, input));
    }
  });

  it("words usage errors in Spanish but keeps the syntax and the operator's text", () => {
    const bad = parseHerdrCommand(ES, "read w1:p1 9999");
    expect(bad).toEqual({ kind: "error", message: '"9999" no es un número de líneas; usa un entero entre 1 y 400.' });
    const usage = parseHerdrCommand(ES, "watch");
    expect(usage.kind).toBe("error");
    if (usage.kind === "error") expect(usage.message).toContain("Uso: /herdr watch <target>");
  });
});

describe("watch notifications", () => {
  const watch = {
    id: "watch-1",
    serverId: "local",
    paneId: "w1:p1",
    terminalId: "term_1",
    agentLabel: "sample#reviewer",
    sessionKey: "session-a",
    promptPreview: "run the tests",
    createdAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T12:00:00.000Z",
    sawWorking: true,
    notificationSeq: 1,
  } as WatchRecord;

  it("keeps the ref, label, prompt and pane output verbatim", () => {
    const out = formatNotification(ES, watch, "blocked", "Allow edit? (y/n)\n", "w1:p1@buildbox");
    expect(out.split("\n")[0]).toBe("Herdr: **w1:p1@buildbox** (sample#reviewer) necesita tu respuesta.");
    expect(out).toContain("> run the tests");
    expect(out).toContain("Allow edit? (y/n)");
    expect(out).toContain("/herdr read w1:p1@buildbox");
  });

  it("has a headline for every settled status", () => {
    for (const status of ["idle", "done", "blocked", "exited", "occupant_changed", "timed_out"] as const) {
      expect(formatNotification(ES, watch, status, undefined)).toMatch(/^Herdr: \*\*w1:p1\*\* \(sample#reviewer\) \S/u);
      expect(formatNotification(ES, watch, status, undefined)).not.toBe(formatNotification(EN, watch, status, undefined));
    }
  });
});

describe("describeFailure", () => {
  it("words the plugin's part and keeps Herdr's message and code", () => {
    expect(describeFailure(ES, new HerdrRequestError({ code: "agent_blocked", message: "x" }))).toBe(ES.agentBlocked);
    expect(describeFailure(ES, new HerdrRequestError({ code: "internal_error", message: "boom" }))).toBe(
      "Herdr rechazó la petición: boom (internal_error).",
    );
    expect(describeFailure(ES, new HerdrTransportError("connect ENOENT"))).toContain("No puedo conectar con Herdr: connect ENOENT.");
    expect(describeFailure(ES, new Error("oops"))).toBe("Error del plugin Herdr: oops");
  });
});

// ---- the runtime end to end ----

const baseAgent: AgentInfo = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: "term_1",
  agent: "claude",
  agent_status: "working",
  focused: true,
  revision: 1,
  state_change_seq: 5,
  foreground_cwd: "/home/alice/sample-project",
};

interface FakeState {
  agents: AgentInfo[];
  prompts: Array<{ target: string; text: string }>;
  /** What `agent.get` reports from now on. */
  current: AgentInfo;
}

function fakeClient(state: FakeState): HerdrClient {
  const client = {
    socketPath: "/fake.sock",
    listAgents: async () => state.agents,
    listTabs: async () => [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "sample#reviewer" }],
    getAgent: async () => state.current,
    readAgent: async () => ({ text: "All 12 tests passed.\n" }),
    prompt: async (target: string, text: string) => {
      state.prompts.push({ target, text });
      return {};
    },
    subscribe: (): Subscription => ({ close: () => {}, closed: new Promise<void>(() => {}), ready: Promise.resolve() }),
  };
  return client as unknown as HerdrClient;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function stateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-i18n-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runtimeIn(
  dir: string,
  language: unknown,
  state: FakeState,
): Promise<{ runtime: HerdrRuntime; notified: string[]; logs: string[] }> {
  const notified: string[] = [];
  const logs: string[] = [];
  const runtime = new HerdrRuntime(
    readPluginConfig({ language, remote: { enabled: false } }),
    { notify: async (_watch, _status, text) => void notified.push(text) },
    { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    fakeClient(state),
  );
  await runtime.start(dir);
  cleanup.unshift(() => runtime.stop());
  return { runtime, notified, logs };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const freshState = (): FakeState => ({ agents: [baseAgent], prompts: [], current: baseAgent });

describe("HerdrRuntime in Spanish", () => {
  /** English sentences that must never reach a Spanish chat. */
  const ENGLISH = [
    "Herdr agents:",
    "Sent to",
    "No agent matches",
    "read-only",
    "Usage:",
    "is not a target",
    "Watching",
    "watching",
    "Stopped",
    "Cannot reach",
    "I know no",
    "will tell you",
    "not being watched",
    "needs an OpenClaw",
  ];
  const expectSpanish = (text: string) => {
    for (const sentinel of ENGLISH) expect(text, `"${sentinel}" in: ${text}`).not.toContain(sentinel);
  };

  it("answers every command in Spanish and keeps ids, labels, paths and output verbatim", async () => {
    const state = freshState();
    const { runtime } = await runtimeIn(await stateDir(), "es", state);
    const caller = { sessionKey: "session-a" };

    const list = await runtime.handleCommand("list", caller);
    expect(list).toContain("Agentes en Herdr:");
    expect(list).toContain("**sample#reviewer** claude · w1:p1 · working");
    expect(list).toContain("sample-project");

    const sent = await runtime.handleCommand("sample#reviewer: run the tests", caller);
    expect(sent).toContain("Enviado a **w1:p1** (sample#reviewer).");
    expect(state.prompts).toEqual([{ target: "w1:p1", text: "run the tests" }]);

    const outputs = [
      list,
      sent,
      await runtime.handleCommand("status", caller),
      await runtime.handleCommand("status w9:p9", caller),
      await runtime.handleCommand("read w1:p1 5", caller),
      await runtime.handleCommand("read", caller),
      await runtime.handleCommand("status w1:p1@nowhere", caller),
      // The tools reach parseTargetRef without the chat grammar in front of it.
      await runtime.status("@nowhere"),
      await runtime.handleCommand("watch w1:p1", {}),
      await runtime.handleCommand("unwatch w1:p1", caller),
      await runtime.handleCommand("unwatch w1:p1", caller),
      await runtime.handleCommand("start", caller),
      await runtime.handleCommand("help", caller),
    ];
    for (const out of outputs) expectSpanish(out);
    expect(outputs[4]).toContain("All 12 tests passed.");
    expect(outputs[3]).toBe("Ningún agente coincide con w9:p9. En marcha: w1:p1 (sample#reviewer).");
    expect(outputs[6]).toContain('No conozco ningún servidor Herdr llamado "nowhere"');
    expect(outputs[7]).toBe('"@nowhere" no es un destino: falta el selector antes de "@".');
    expect(outputs[8]).toBe(ES.watchNeedsSession);
  });

  it("reports a missing Herdr in Spanish", async () => {
    const state = freshState();
    const { runtime } = await runtimeIn(await stateDir(), "es", state);
    (runtime.client as unknown as { listAgents: () => Promise<never> }).listAgents = async () => {
      throw new HerdrTransportError("connect ENOENT");
    };
    const out = await runtime.handleCommand("status", {});
    expect(out).toContain("No puedo conectar con Herdr");
    expectSpanish(out);
  });

  it("warns and replies in English for an unsupported language", async () => {
    const { runtime, logs } = await runtimeIn(await stateDir(), "fr", freshState());
    expect(await runtime.handleCommand("status w9:p9", {})).toContain("No agent matches w9:p9");
    expect(logs.some((line) => line.includes('language "fr" is not supported'))).toBe(true);
  });
});

describe("watch notification language across restarts", () => {
  async function settleAfterRestart(first: Language, second: Language): Promise<string> {
    const dir = await stateDir();
    const state = freshState();
    const before = await runtimeIn(dir, first, state);
    await before.runtime.handleCommand("w1:p1: run the tests", { sessionKey: "session-a" });
    await before.runtime.stop();
    // The agent finished while the plugin was down; the next start reconciles.
    state.current = { ...baseAgent, agent_status: "idle", state_change_seq: 9 };
    const after = await runtimeIn(dir, second, state);
    await waitFor(() => after.notified.length > 0);
    return after.notified[0] as string;
  }

  it("notifies in the language of the chat that asked, not the current setting", async () => {
    expect((await settleAfterRestart("es", "en")).split("\n")[0]).toBe("Herdr: **w1:p1** (sample#reviewer) ha terminado.");
    expect((await settleAfterRestart("en", "es")).split("\n")[0]).toBe("Herdr: **w1:p1** (sample#reviewer) finished.");
  });

  it("keeps each watch's own language when two chats watch with different settings", async () => {
    const dir = await stateDir();
    const state = freshState();
    const spanish = await runtimeIn(dir, "es", state);
    await spanish.runtime.handleCommand("w1:p1: run the tests", { sessionKey: "session-a" });
    await spanish.runtime.stop();
    const english = await runtimeIn(dir, "en", state);
    await english.runtime.handleCommand("w1:p1: run the linter", { sessionKey: "session-b" });
    await english.runtime.stop();
    state.current = { ...baseAgent, agent_status: "idle", state_change_seq: 9 };
    const after = await runtimeIn(dir, "en", state);
    await waitFor(() => after.notified.length === 2);
    const bySession = after.notified.map((text) => text.split("\n")[0]).sort();
    expect(bySession).toEqual([
      "Herdr: **w1:p1** (sample#reviewer) finished.",
      "Herdr: **w1:p1** (sample#reviewer) ha terminado.",
    ]);
  });

  it("reads legacy and unknown-language records as English without quarantining them", async () => {
    const dir = await stateDir();
    const record = (id: string, extra: Record<string, unknown>) => ({
      id,
      paneId: "w1:p1",
      terminalId: "term_1",
      agentLabel: "claude",
      sessionKey: `session-${id}`,
      promptPreview: "p",
      createdAt: "2026-09-19T10:00:00.000Z",
      deadlineAt: "2099-09-20T10:00:00.000Z",
      ...extra,
    });
    await fs.writeFile(
      path.join(dir, "watches.json"),
      JSON.stringify({ version: 1, watches: [record("legacy", {}), record("odd", { language: "fr" }), record("es", { language: "es" })] }),
    );
    const store = new WatchStore(dir);
    await store.load();
    const byId = Object.fromEntries(store.list().map((watch) => [watch.id, watch.language]));
    expect(byId).toEqual({ legacy: undefined, odd: undefined, es: "es" });
  });
});
