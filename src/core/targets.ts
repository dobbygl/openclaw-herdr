import type { AgentInfo } from "../herdr/types.js";

export type TargetResolution =
  | { ok: true; agent: AgentInfo }
  | { ok: false; reason: "none" | "ambiguous" | "not_found"; message: string; candidates: AgentInfo[] };

/** Selector kinds, most specific first. A level is only consulted when every earlier level matched nothing. */
const LEVELS: ReadonlyArray<{ label: string; hint: string; value: (agent: AgentInfo) => string }> = [
  { label: "pane id", hint: "use a terminal id", value: (agent) => agent.pane_id },
  { label: "terminal id", hint: "use a pane id", value: (agent) => agent.terminal_id },
  { label: "agent name", hint: "use a pane id", value: (agent) => agent.name ?? "" },
  { label: "agent kind", hint: "use a pane id", value: (agent) => agent.agent ?? "" },
];

/**
 * Turn a user-typed selector into exactly one live Herdr agent.
 *
 * Matching has an explicit precedence: pane id, then terminal id, then agent
 * name, then agent kind (`claude`, `codex`). The next level is only tried when
 * the current one has no match at all, so a pane id always wins over another
 * agent's name, and a name always wins over a kind. Two or more matches inside
 * one level are a refusal that lists the candidates: the plugin never guesses.
 */
export function resolveTarget(agents: AgentInfo[], selector?: string): TargetResolution {
  const live = agents.filter((agent) => agent.agent !== null);
  if (!selector || selector.trim() === "") {
    if (live.length === 1) return { ok: true, agent: live[0] as AgentInfo };
    if (live.length === 0) {
      return { ok: false, reason: "none", message: "Herdr sees no running coding agent.", candidates: [] };
    }
    return {
      ok: false,
      reason: "ambiguous",
      message: `Several agents are running; name one: ${describeCandidates(live)}.`,
      candidates: live,
    };
  }
  const wanted = selector.trim().toLowerCase();
  // A selector still carrying "@server" was not stripped by the caller: this
  // function only resolves a bare selector on one machine's agent list, so
  // it never matches here rather than guessing which machine was meant.
  if (wanted.includes("@")) {
    return {
      ok: false,
      reason: "not_found",
      message: `${selector} looks like a selector@server target; machine suffixes are resolved per machine.`,
      candidates: [],
    };
  }
  for (const level of LEVELS) {
    const matches = live.filter((agent) => {
      const value = level.value(agent);
      return value !== "" && value.toLowerCase() === wanted;
    });
    if (matches.length === 1) return { ok: true, agent: matches[0] as AgentInfo };
    if (matches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: `${selector} matches ${matches.length} agents by ${level.label}; ${level.hint}: ${describeCandidates(matches)}.`,
        candidates: matches,
      };
    }
  }
  return {
    ok: false,
    reason: "not_found",
    message:
      live.length === 0
        ? `No agent matches ${selector}; Herdr sees no running coding agent.`
        : `No agent matches ${selector}. Running: ${describeCandidates(live)}.`,
    candidates: live,
  };
}

export function describeCandidates(agents: AgentInfo[]): string {
  return agents.map((agent) => `${agent.pane_id} (${agent.name ?? agent.agent ?? "?"})`).join(", ");
}

/**
 * Thin convenience over {@link resolveTarget} for a `{ selector, server }`
 * ref (e.g. from `parseTargetRef`). It strips nothing and does not act on
 * `server` itself: picking the right machine's agent list for `server` is
 * the runtime's job, this just resolves the bare selector against whatever
 * agent list is passed in.
 */
export function resolveTargetRef(agents: AgentInfo[], ref: { selector?: string; server?: string }): TargetResolution {
  return resolveTarget(agents, ref.selector);
}
