import type { AgentInfo } from "../herdr/types.js";

export type TargetResolution =
  | { ok: true; agent: AgentInfo }
  | { ok: false; reason: "none" | "ambiguous" | "not_found"; message: string; candidates: AgentInfo[] };

/**
 * Turn a user-typed selector into exactly one live Herdr agent.
 * Accepts a pane id (`w6:p1`), a Herdr agent name, a terminal id, or an agent
 * kind (`claude`, `codex`) when only one such agent is running. Anything that
 * matches more than one agent is an error: the plugin never guesses.
 */
export function resolveTarget(agents: AgentInfo[], selector?: string): TargetResolution {
  const live = agents.filter((agent) => agent.agent !== null);
  if (!selector) {
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
  const exact = live.filter(
    (agent) =>
      agent.pane_id.toLowerCase() === wanted ||
      agent.terminal_id.toLowerCase() === wanted ||
      (agent.name ?? "").toLowerCase() === wanted,
  );
  if (exact.length === 1) return { ok: true, agent: exact[0] as AgentInfo };
  const byKind = live.filter((agent) => (agent.agent ?? "").toLowerCase() === wanted);
  if (byKind.length === 1) return { ok: true, agent: byKind[0] as AgentInfo };
  if (byKind.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `${selector} matches ${byKind.length} agents; use a pane id: ${describeCandidates(byKind)}.`,
      candidates: byKind,
    };
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
