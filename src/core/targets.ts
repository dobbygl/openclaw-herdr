import type { AgentInfo } from "../herdr/types.js";
import { LABEL_MAX_CHARS, preview } from "./format.js";
import type { Messages, TargetLevel } from "./i18n.js";
import { agentDisplayName } from "./labels.js";

export type TargetResolution =
  | { ok: true; agent: AgentInfo }
  | { ok: false; reason: "none" | "ambiguous" | "not_found"; message: string; candidates: AgentInfo[] };

/** Selector kinds, most specific first. A level is only consulted when every earlier level matched nothing. */
const LEVELS: ReadonlyArray<{ level: TargetLevel; hint: "useTerminalId" | "usePaneId"; value: (agent: AgentInfo) => string }> = [
  { level: "pane_id", hint: "useTerminalId", value: (agent) => agent.pane_id },
  { level: "terminal_id", hint: "usePaneId", value: (agent) => agent.terminal_id },
  { level: "agent_name", hint: "usePaneId", value: (agent) => agent.name ?? "" },
  { level: "tab_label", hint: "usePaneId", value: (agent) => agent.tab_label ?? "" },
  { level: "agent_kind", hint: "usePaneId", value: (agent) => agent.agent ?? "" },
];

/**
 * Turn a user-typed selector into exactly one live Herdr agent.
 *
 * Matching has an explicit precedence: pane id, then terminal id, then agent
 * name, then the operator's tab label (`sample#reviewer`, see `labels.ts`),
 * then agent kind (`claude`, `codex`). The next level is only tried when the
 * current one has no match at all, so a pane id always wins over another
 * agent's name, a name over a tab label, and a tab label over a kind. Two or
 * more matches inside one level are a refusal that lists the candidates: the
 * plugin never guesses. A tab label is also refused when it is on more than
 * one tab, even if only one of those tabs runs an agent.
 */
export function resolveTarget(m: Messages, agents: AgentInfo[], selector?: string): TargetResolution {
  const live = agents.filter((agent) => agent.agent !== null);
  if (!selector || selector.trim() === "") {
    if (live.length === 1) return { ok: true, agent: live[0] as AgentInfo };
    if (live.length === 0) {
      return { ok: false, reason: "none", message: m.noAgentRunning, candidates: [] };
    }
    return {
      ok: false,
      reason: "ambiguous",
      message: m.severalAgents(describeCandidates(live)),
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
      message: m.selectorHasServer(selector),
      candidates: [],
    };
  }
  for (const level of LEVELS) {
    const matches = live.filter((agent) => {
      const value = level.value(agent);
      return value !== "" && value.toLowerCase() === wanted;
    });
    const hint = m[level.hint];
    const sharedTabs = matches.find((agent) => level.level === "tab_label" && agent.tab_label_tab_ids)?.tab_label_tab_ids;
    if (sharedTabs) {
      return {
        ok: false,
        reason: "ambiguous",
        message: m.labelOnTabs(selector, sharedTabs.length, sharedTabs.join(", "), hint, describeCandidates(matches)),
        candidates: matches,
      };
    }
    if (matches.length === 1) return { ok: true, agent: matches[0] as AgentInfo };
    if (matches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: m.ambiguousTarget(selector, matches.length, m.levelName(level.level), hint, describeCandidates(matches)),
        candidates: matches,
      };
    }
  }
  return {
    ok: false,
    reason: "not_found",
    message:
      live.length === 0 ? m.noMatchNoAgents(selector) : m.noMatch(selector, describeCandidates(live)),
    candidates: live,
  };
}

export function describeCandidates(agents: AgentInfo[]): string {
  return agents.map((agent) => `${agent.pane_id} (${preview(agentDisplayName(agent) ?? agent.agent ?? "?", LABEL_MAX_CHARS)})`).join(", ");
}

/**
 * Thin convenience over {@link resolveTarget} for a `{ selector, server }`
 * ref (e.g. from `parseTargetRef`). It strips nothing and does not act on
 * `server` itself: picking the right machine's agent list for `server` is
 * the runtime's job, this just resolves the bare selector against whatever
 * agent list is passed in.
 */
export function resolveTargetRef(
  m: Messages,
  agents: AgentInfo[],
  ref: { selector?: string; server?: string },
): TargetResolution {
  return resolveTarget(m, agents, ref.selector);
}
