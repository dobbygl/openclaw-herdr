import { describe, expect, it } from "vitest";
import { resolveTarget } from "../src/core/targets.js";
import type { AgentInfo } from "../src/herdr/types.js";

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  pane_id: "w1:p1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: "term_a",
  agent: "claude",
  agent_status: "idle",
  focused: false,
  revision: 1,
  ...over,
});

describe("resolveTarget", () => {
  const claude = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude" });
  const codex = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "reviewer" });
  const shell = agent({ pane_id: "w6:p3", terminal_id: "term_3", agent: null });

  it("picks the only live agent when no selector is given", () => {
    expect(resolveTarget([claude, shell])).toEqual({ ok: true, agent: claude });
  });
  it("refuses to guess between several agents", () => {
    const result = resolveTarget([claude, codex]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
  });
  it("matches pane id, name, terminal id and unique kind", () => {
    expect(resolveTarget([claude, codex], "w6:p2")).toEqual({ ok: true, agent: codex });
    expect(resolveTarget([claude, codex], "reviewer")).toEqual({ ok: true, agent: codex });
    expect(resolveTarget([claude, codex], "TERM_1")).toEqual({ ok: true, agent: claude });
    expect(resolveTarget([claude, codex], "codex")).toEqual({ ok: true, agent: codex });
  });
  it("reports ambiguous kinds and unknown selectors", () => {
    const second = agent({ pane_id: "w7:p1", terminal_id: "term_9", agent: "claude" });
    const ambiguous = resolveTarget([claude, second], "claude");
    expect(ambiguous.ok).toBe(false);
    const missing = resolveTarget([claude], "w9:p9");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });
});
