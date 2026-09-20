import { describe, expect, it } from "vitest";
import { resolveTarget, resolveTargetRef } from "../src/core/targets.js";
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
    expect(resolveTarget([claude, shell], "  ")).toEqual({ ok: true, agent: claude });
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

  describe("precedence", () => {
    it("level 1: a pane id wins over another agent's name", () => {
      // The whole point of the fix: `w6:p1` is claude's pane id and also the
      // name someone gave the codex pane. The pane id level has exactly one
      // match, so no later level is consulted and nothing is ambiguous.
      const namedLikeAPane = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "w6:p1" });
      expect(resolveTarget([claude, namedLikeAPane], "w6:p1")).toEqual({ ok: true, agent: claude });
    });
    it("level 2: a terminal id wins over another agent's name and kind", () => {
      const namedLikeATerminal = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "term_1" });
      expect(resolveTarget([claude, namedLikeATerminal], "term_1")).toEqual({ ok: true, agent: claude });
    });
    it("level 3: a name wins over an agent of that kind", () => {
      // Two agents named `codex` plus a third that IS a codex: the name level
      // decides, and the kind level is never reached.
      const named = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude", name: "codex" });
      const realCodex = agent({ pane_id: "w6:p9", terminal_id: "term_9", agent: "codex" });
      expect(resolveTarget([named, realCodex], "codex")).toEqual({ ok: true, agent: named });
    });
    it("level 4: a kind matches only when nothing more specific did", () => {
      expect(resolveTarget([claude, codex], "claude")).toEqual({ ok: true, agent: claude });
    });
    it("never matches an agent on an absent name", () => {
      const nameless = agent({ pane_id: "w6:p4", terminal_id: "term_4", agent: "claude", name: null });
      const result = resolveTarget([nameless], "w6:p9");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_found");
    });
  });

  describe("ambiguity at each level", () => {
    const expectAmbiguous = (selector: string, agents: AgentInfo[], candidates: AgentInfo[], label: string) => {
      const result = resolveTarget(agents, selector);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates).toEqual(candidates);
      expect(result.message).toContain(`by ${label}`);
    };

    it("refuses two agents sharing a pane id", () => {
      const twin = agent({ pane_id: "w6:p1", terminal_id: "term_8", agent: "codex" });
      expectAmbiguous("w6:p1", [claude, twin], [claude, twin], "pane id");
    });
    it("refuses two agents sharing a terminal id", () => {
      const twin = agent({ pane_id: "w6:p8", terminal_id: "term_1", agent: "codex" });
      expectAmbiguous("term_1", [claude, twin], [claude, twin], "terminal id");
    });
    it("refuses two agents sharing a name", () => {
      const first = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude", name: "codex" });
      const second = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "claude", name: "CODEX" });
      const realCodex = agent({ pane_id: "w6:p3", terminal_id: "term_3", agent: "codex" });
      expectAmbiguous("codex", [first, second, realCodex], [first, second], "agent name");
    });
    it("refuses two agents of the same kind", () => {
      const second = agent({ pane_id: "w7:p1", terminal_id: "term_9", agent: "claude" });
      expectAmbiguous("claude", [claude, second], [claude, second], "agent kind");
    });
    it("lists the candidates and how to disambiguate", () => {
      const second = agent({ pane_id: "w7:p1", terminal_id: "term_9", agent: "claude" });
      const result = resolveTarget([claude, second], "claude");
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toBe(
        "claude matches 2 agents by agent kind; use a pane id: w6:p1 (claude), w7:p1 (claude).",
      );
    });
    it("tells a pane-id clash to use a terminal id", () => {
      const twin = agent({ pane_id: "w6:p1", terminal_id: "term_8", agent: "codex" });
      const result = resolveTarget([claude, twin], "w6:p1");
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("use a terminal id");
    });
  });

  it("ignores panes without an agent at every level", () => {
    const deadPane = agent({ pane_id: "w6:p9", terminal_id: "term_9", agent: null, name: "reviewer" });
    expect(resolveTarget([codex, deadPane], "reviewer")).toEqual({ ok: true, agent: codex });
    const none = resolveTarget([deadPane], "reviewer");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("not_found");
  });

  describe("a selector that still carries a machine suffix", () => {
    it("never matches, even if it would otherwise look like a pane id or name", () => {
      const result = resolveTarget([claude, codex], "w6:p1@buildbox");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not_found");
      expect(result.candidates).toEqual([]);
    });

    it("says machine suffixes are resolved per machine, not guessed at here", () => {
      const result = resolveTarget([claude, codex], "reviewer@buildbox");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("per machine");
    });
  });
});

describe("resolveTargetRef", () => {
  const claude = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude" });
  const codex = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "reviewer" });

  it("delegates to resolveTarget with the bare selector, ignoring server", () => {
    expect(resolveTargetRef([claude, codex], { selector: "w6:p2" })).toEqual(resolveTarget([claude, codex], "w6:p2"));
    expect(resolveTargetRef([claude, codex], { selector: "reviewer", server: "buildbox" })).toEqual(
      resolveTarget([claude, codex], "reviewer"),
    );
  });

  it("falls back to resolveTarget's no-selector behavior when selector is absent", () => {
    expect(resolveTargetRef([claude], {})).toEqual(resolveTarget([claude]));
  });
});
