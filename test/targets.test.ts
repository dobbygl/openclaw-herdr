import { describe, expect, it } from "vitest";
import { resolveTarget, resolveTargetRef } from "../src/core/targets.js";
import type { AgentInfo } from "../src/herdr/types.js";
import { messages } from "../src/core/i18n.js";

const EN = messages("en");

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
    expect(resolveTarget(EN, [claude, shell])).toEqual({ ok: true, agent: claude });
    expect(resolveTarget(EN, [claude, shell], "  ")).toEqual({ ok: true, agent: claude });
  });
  it("refuses to guess between several agents", () => {
    const result = resolveTarget(EN, [claude, codex]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
  });
  it("matches pane id, name, terminal id and unique kind", () => {
    expect(resolveTarget(EN, [claude, codex], "w6:p2")).toEqual({ ok: true, agent: codex });
    expect(resolveTarget(EN, [claude, codex], "reviewer")).toEqual({ ok: true, agent: codex });
    expect(resolveTarget(EN, [claude, codex], "TERM_1")).toEqual({ ok: true, agent: claude });
    expect(resolveTarget(EN, [claude, codex], "codex")).toEqual({ ok: true, agent: codex });
  });
  it("reports ambiguous kinds and unknown selectors", () => {
    const second = agent({ pane_id: "w7:p1", terminal_id: "term_9", agent: "claude" });
    const ambiguous = resolveTarget(EN, [claude, second], "claude");
    expect(ambiguous.ok).toBe(false);
    const missing = resolveTarget(EN, [claude], "w9:p9");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });

  describe("precedence", () => {
    it("level 1: a pane id wins over another agent's name", () => {
      // The whole point of the fix: `w6:p1` is claude's pane id and also the
      // name someone gave the codex pane. The pane id level has exactly one
      // match, so no later level is consulted and nothing is ambiguous.
      const namedLikeAPane = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "w6:p1" });
      expect(resolveTarget(EN, [claude, namedLikeAPane], "w6:p1")).toEqual({ ok: true, agent: claude });
    });
    it("level 2: a terminal id wins over another agent's name and kind", () => {
      const namedLikeATerminal = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "term_1" });
      expect(resolveTarget(EN, [claude, namedLikeATerminal], "term_1")).toEqual({ ok: true, agent: claude });
    });
    it("level 3: a name wins over an agent of that kind", () => {
      // Two agents named `codex` plus a third that IS a codex: the name level
      // decides, and the kind level is never reached.
      const named = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude", name: "codex" });
      const realCodex = agent({ pane_id: "w6:p9", terminal_id: "term_9", agent: "codex" });
      expect(resolveTarget(EN, [named, realCodex], "codex")).toEqual({ ok: true, agent: named });
    });
    it("level 4: a kind matches only when nothing more specific did", () => {
      expect(resolveTarget(EN, [claude, codex], "claude")).toEqual({ ok: true, agent: claude });
    });
    it("never matches an agent on an absent name", () => {
      const nameless = agent({ pane_id: "w6:p4", terminal_id: "term_4", agent: "claude", name: null });
      const result = resolveTarget(EN, [nameless], "w6:p9");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_found");
    });
  });

  describe("ambiguity at each level", () => {
    const expectAmbiguous = (selector: string, agents: AgentInfo[], candidates: AgentInfo[], label: string) => {
      const result = resolveTarget(EN, agents, selector);
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
      const result = resolveTarget(EN, [claude, second], "claude");
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toBe(
        "claude matches 2 agents by agent kind; use a pane id: w6:p1 (claude), w7:p1 (claude).",
      );
    });
    it("tells a pane-id clash to use a terminal id", () => {
      const twin = agent({ pane_id: "w6:p1", terminal_id: "term_8", agent: "codex" });
      const result = resolveTarget(EN, [claude, twin], "w6:p1");
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("use a terminal id");
    });
  });

  it("ignores panes without an agent at every level", () => {
    const deadPane = agent({ pane_id: "w6:p9", terminal_id: "term_9", agent: null, name: "reviewer" });
    expect(resolveTarget(EN, [codex, deadPane], "reviewer")).toEqual({ ok: true, agent: codex });
    const none = resolveTarget(EN, [deadPane], "reviewer");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("not_found");
  });

  describe("a selector that still carries a machine suffix", () => {
    it("never matches, even if it would otherwise look like a pane id or name", () => {
      const result = resolveTarget(EN, [claude, codex], "w6:p1@buildbox");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not_found");
      expect(result.candidates).toEqual([]);
    });

    it("says machine suffixes are resolved per machine, not guessed at here", () => {
      const result = resolveTarget(EN, [claude, codex], "reviewer@buildbox");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("per machine");
    });
  });
});

describe("resolveTarget with tab labels", () => {
  // Two single-pane tabs whose agents have no Herdr name: the label is all the
  // operator gave them.
  const reviewer = agent({ pane_id: "w1:p1", tab_id: "w1:t1", terminal_id: "term_1", agent: "claude", tab_label: "sample#reviewer" });
  const builder = agent({ pane_id: "w1:p2", tab_id: "w1:t2", terminal_id: "term_2", agent: "codex", tab_label: "sample#builder" });

  it("resolves an unnamed agent by its tab label, case-insensitively", () => {
    expect(resolveTarget(EN, [reviewer, builder], "sample#reviewer")).toEqual({ ok: true, agent: reviewer });
    expect(resolveTarget(EN, [reviewer, builder], "SAMPLE#Builder")).toEqual({ ok: true, agent: builder });
  });
  it("keeps pane and terminal ids first", () => {
    const labelledLikeAPane = { ...builder, tab_label: "w1:p1" };
    expect(resolveTarget(EN, [reviewer, labelledLikeAPane], "w1:p1")).toEqual({ ok: true, agent: reviewer });
    const labelledLikeATerminal = { ...builder, tab_label: "term_1" };
    expect(resolveTarget(EN, [reviewer, labelledLikeATerminal], "term_1")).toEqual({ ok: true, agent: reviewer });
  });
  it("lets an agent name win over another agent's tab label", () => {
    const named = { ...builder, name: "sample#reviewer" };
    expect(resolveTarget(EN, [reviewer, named], "sample#reviewer")).toEqual({ ok: true, agent: named });
  });
  it("still resolves a named agent by its name when its tab is labelled too", () => {
    const named = { ...reviewer, name: "reviewer" };
    expect(resolveTarget(EN, [named, builder], "reviewer")).toEqual({ ok: true, agent: named });
    expect(resolveTarget(EN, [named, builder], "sample#reviewer")).toEqual({ ok: true, agent: named });
  });
  it("lets a tab label win over an agent kind", () => {
    // A tab labelled `claude` that runs codex beats the real claude agent:
    // the label is what the operator typed on purpose.
    const labelledClaude = { ...builder, tab_label: "claude" };
    expect(resolveTarget(EN, [reviewer, labelledClaude], "claude")).toEqual({ ok: true, agent: labelledClaude });
  });
  it("falls back to the kind when no tab is labelled (no tab metadata)", () => {
    const plain = [agent({ pane_id: "w1:p1", agent: "claude" }), agent({ pane_id: "w1:p2", terminal_id: "term_2", agent: "codex" })];
    expect(resolveTarget(EN, plain, "codex")).toEqual({ ok: true, agent: plain[1] });
    const missing = resolveTarget(EN, plain, "sample#reviewer");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });
  it("refuses a tab with several agents and lists their pane ids", () => {
    const second = agent({ pane_id: "w1:p3", tab_id: "w1:t1", terminal_id: "term_3", agent: "codex", tab_label: "sample#reviewer" });
    const result = resolveTarget(EN, [reviewer, second, builder], "sample#reviewer");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates).toEqual([reviewer, second]);
    expect(result.message).toBe(
      "sample#reviewer matches 2 agents by tab label; use a pane id: w1:p1 (sample#reviewer), w1:p3 (sample#reviewer).",
    );
  });
  it("refuses a label that is on several tabs, even when only one runs an agent", () => {
    const shared = { ...reviewer, tab_label_tab_ids: ["w1:t1", "w2:t4"] };
    const result = resolveTarget(EN, [shared, builder], "sample#reviewer");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates).toEqual([shared]);
    expect(result.message).toBe("sample#reviewer labels 2 tabs (w1:t1, w2:t4); use a pane id: w1:p1 (sample#reviewer).");
  });
  it("refuses two tabs sharing a label that both run agents", () => {
    const twin = { ...builder, tab_label: "sample#reviewer", tab_label_tab_ids: ["w1:t1", "w1:t2"] };
    const first = { ...reviewer, tab_label_tab_ids: ["w1:t1", "w1:t2"] };
    const result = resolveTarget(EN, [first, twin], "sample#reviewer");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.candidates).toEqual([first, twin]);
    expect(result.message).toContain("w1:p1");
    expect(result.message).toContain("w1:p2");
  });
  it("still refuses a machine-qualified selector here", () => {
    const result = resolveTarget(EN, [reviewer, builder], "sample#reviewer@buildbox");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("per machine");
  });
  it("names candidates by label when nothing matches, with hostile text flattened", () => {
    const hostile = { ...builder, tab_label: "evil\nlabel" };
    const result = resolveTarget(EN, [reviewer, hostile], "w9:p9");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toBe("No agent matches w9:p9. Running: w1:p1 (sample#reviewer), w1:p2 (evil label).");
  });
});

describe("resolveTargetRef", () => {
  const claude = agent({ pane_id: "w6:p1", terminal_id: "term_1", agent: "claude" });
  const codex = agent({ pane_id: "w6:p2", terminal_id: "term_2", agent: "codex", name: "reviewer" });

  it("delegates to resolveTarget with the bare selector, ignoring server", () => {
    expect(resolveTargetRef(EN, [claude, codex], { selector: "w6:p2" })).toEqual(resolveTarget(EN, [claude, codex], "w6:p2"));
    expect(resolveTargetRef(EN, [claude, codex], { selector: "reviewer", server: "buildbox" })).toEqual(
      resolveTarget(EN, [claude, codex], "reviewer"),
    );
  });

  it("falls back to resolveTarget's no-selector behavior when selector is absent", () => {
    expect(resolveTargetRef(EN, [claude], {})).toEqual(resolveTarget(EN, [claude]));
  });
});
