import { afterEach, describe, expect, it } from "vitest";
import { agentDisplayName, listLabelledAgents, operatorTabLabel, withTabLabels } from "../src/core/labels.js";
import { HerdrClient, HerdrRequestError, HerdrTransportError, isUnknownMethodError } from "../src/herdr/client.js";
import type { AgentInfo, TabInfo } from "../src/herdr/types.js";
import { startFakeHerdr, type FakeHerdr } from "./fixtures/fake-herdr-server.js";

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  pane_id: "w1:p1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: "term_1",
  agent: "claude",
  agent_status: "idle",
  focused: false,
  revision: 1,
  ...over,
});

const tab = (over: Partial<TabInfo>): TabInfo => ({
  tab_id: "w1:t1",
  workspace_id: "w1",
  label: "1",
  number: 1,
  pane_count: 1,
  focused: false,
  ...over,
});

/** The issue's shape: two single-pane tabs, unnamed agents, labels only in `tab.list`. */
const reviewer = agent({ pane_id: "w1:p1", tab_id: "w1:t1", terminal_id: "term_1", agent: "claude" });
const builder = agent({ pane_id: "w1:p2", tab_id: "w1:t2", terminal_id: "term_2", agent: "codex" });
const TABS = [
  tab({ tab_id: "w1:t1", label: "sample#reviewer", number: 1 }),
  tab({ tab_id: "w1:t2", label: "sample#builder", number: 2 }),
];

describe("operatorTabLabel", () => {
  it("keeps a label the operator assigned", () => {
    expect(operatorTabLabel(tab({ label: "sample#reviewer" }))).toBe("sample#reviewer");
  });
  it("treats Herdr's default label (the tab number) and blanks as no label", () => {
    expect(operatorTabLabel(tab({ label: "1", number: 1 }))).toBeUndefined();
    expect(operatorTabLabel(tab({ label: "  ", number: 1 }))).toBeUndefined();
  });
  it("keeps a numeric label that is not the tab's own number", () => {
    expect(operatorTabLabel(tab({ label: "7", number: 1 }))).toBe("7");
  });
});

describe("withTabLabels", () => {
  it("labels unnamed agents from their tab", () => {
    const [first, second] = withTabLabels([reviewer, builder], TABS);
    expect(first?.tab_label).toBe("sample#reviewer");
    expect(second?.tab_label).toBe("sample#builder");
    expect(first?.tab_label_tab_ids).toBeUndefined();
  });
  it("leaves agents in unknown or unlabelled tabs untouched", () => {
    const stray = agent({ pane_id: "w2:p1", tab_id: "w2:t1" });
    const unlabelled = agent({ pane_id: "w1:p3", tab_id: "w1:t3" });
    const out = withTabLabels([stray, unlabelled], [...TABS, tab({ tab_id: "w1:t3", label: "3", number: 3 })]);
    expect(out).toEqual([stray, unlabelled]);
  });
  it("marks a label shared by several tabs, case-insensitively", () => {
    const out = withTabLabels(
      [reviewer, builder],
      [tab({ tab_id: "w1:t1", label: "sample#reviewer" }), tab({ tab_id: "w1:t2", label: "Sample#Reviewer", number: 2 })],
    );
    expect(out.map((entry) => entry.tab_label_tab_ids)).toEqual([
      ["w1:t1", "w1:t2"],
      ["w1:t1", "w1:t2"],
    ]);
  });
  it("does not count default labels as duplicates", () => {
    const out = withTabLabels(
      [reviewer],
      [tab({ tab_id: "w1:t1", label: "sample#reviewer" }), tab({ tab_id: "w2:t1", workspace_id: "w2", label: "1", number: 1 })],
    );
    expect(out[0]?.tab_label_tab_ids).toBeUndefined();
  });
  it("drops enrichment the agent no longer deserves", () => {
    const stale = agent({ tab_label: "old", tab_label_tab_ids: ["w1:t1", "w1:t9"] });
    expect(withTabLabels([stale], [tab({ label: "1" })])[0]).toEqual(agent({}));
  });
});

describe("agentDisplayName", () => {
  it("prefers the Herdr agent name, then the tab label", () => {
    expect(agentDisplayName(agent({ name: "reviewer", tab_label: "sample#reviewer" }))).toBe("reviewer");
    expect(agentDisplayName(agent({ tab_label: "sample#reviewer" }))).toBe("sample#reviewer");
    expect(agentDisplayName(agent({ name: null }))).toBeUndefined();
  });
  it("never uses the terminal title as a name", () => {
    expect(agentDisplayName(agent({ terminal_title_stripped: "fixing the tests" }))).toBeUndefined();
  });
});

describe("listLabelledAgents", () => {
  const client = (listTabs: () => Promise<TabInfo[]>) => ({ listAgents: async () => [reviewer, builder], listTabs });

  it("joins agent.list and tab.list", async () => {
    const out = await listLabelledAgents(client(async () => TABS));
    expect(out.map((entry) => entry.tab_label)).toEqual(["sample#reviewer", "sample#builder"]);
  });
  it("falls back to plain agents when Herdr does not know tab.list", async () => {
    const unknown = new HerdrRequestError({
      code: "invalid_request",
      message: "invalid request: unknown variant `tab.list`, expected one of `ping`",
    });
    expect(await listLabelledAgents(client(async () => Promise.reject(unknown)))).toEqual([reviewer, builder]);
  });
  it("falls back when tab.list returns no usable rows", async () => {
    expect(await listLabelledAgents(client(async () => []))).toEqual([reviewer, builder]);
  });
  it.each([
    ["permission_denied", "not allowed"],
    ["internal_error", "boom"],
    ["invalid_request", "invalid request: missing field `x`"],
    ["invalid_request", "invalid request: unknown variant `tab.frobnicate`"],
  ])("propagates a real refusal (%s: %s)", async (code, message) => {
    const refusal = new HerdrRequestError({ code, message });
    await expect(listLabelledAgents(client(async () => Promise.reject(refusal)))).rejects.toBe(refusal);
  });
  it("propagates a transport failure", async () => {
    const failure = new HerdrTransportError("socket closed");
    await expect(listLabelledAgents(client(async () => Promise.reject(failure)))).rejects.toBe(failure);
  });
  it("propagates an agent.list failure even when tab.list is fine", async () => {
    const failure = new HerdrTransportError("socket closed");
    const broken = { listAgents: async () => Promise.reject(failure), listTabs: async () => TABS };
    await expect(listLabelledAgents(broken)).rejects.toBe(failure);
  });
});

describe("isUnknownMethodError", () => {
  it("matches only Herdr's unknown-variant refusal for that method", () => {
    const unknown = new HerdrRequestError({ code: "invalid_request", message: "invalid request: unknown variant `tab.list`, expected …" });
    expect(isUnknownMethodError(unknown, "tab.list")).toBe(true);
    expect(isUnknownMethodError(unknown, "agent.list")).toBe(false);
    expect(isUnknownMethodError(new HerdrRequestError({ code: "internal_error", message: "unknown variant `tab.list`" }), "tab.list")).toBe(false);
    expect(isUnknownMethodError(new HerdrTransportError("unknown variant `tab.list`"), "tab.list")).toBe(false);
  });
});

describe("tab labels over the socket", () => {
  let fake: FakeHerdr | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });
  const HERD = [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term_1", agent: "claude", agent_status: "idle" },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", terminal_id: "term_2", agent: "codex", agent_status: "idle" },
  ];

  it("reads tab.list and drops malformed rows", async () => {
    fake = await startFakeHerdr("herdr-tabs-", {
      agents: HERD,
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "sample#reviewer", focused: false, pane_count: 1, agent_status: "idle", vibe: "new field" },
        { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: 42 },
        "not-a-tab",
      ],
    });
    const client = new HerdrClient({ socketPath: fake.socketPath, requestTimeoutMs: 2_000 });
    expect((await client.listTabs()).map((row) => row.tab_id)).toEqual(["w1:t1"]);
    const out = await listLabelledAgents(client);
    expect(out.map((entry) => entry.tab_label)).toEqual(["sample#reviewer", undefined]);
  });

  it("works against a Herdr without tab.list", async () => {
    fake = await startFakeHerdr("herdr-tabs-", { agents: HERD });
    const client = new HerdrClient({ socketPath: fake.socketPath, requestTimeoutMs: 2_000 });
    const out = await listLabelledAgents(client);
    expect(out.map((entry) => entry.pane_id)).toEqual(["w1:p1", "w1:p2"]);
    expect(out.every((entry) => entry.tab_label === undefined)).toBe(true);
  });

  it("surfaces a tab.list refusal instead of an unlabelled herd", async () => {
    fake = await startFakeHerdr("herdr-tabs-", { agents: HERD, tabs: [] });
    fake.setTabsError({ code: "permission_denied", message: "tab.list is not allowed" });
    const client = new HerdrClient({ socketPath: fake.socketPath, requestTimeoutMs: 2_000 });
    await expect(listLabelledAgents(client)).rejects.toMatchObject({ code: "permission_denied" });
  });
});
