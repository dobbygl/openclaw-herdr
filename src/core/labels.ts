/**
 * Operator-facing names for agents.
 *
 * Herdr gives an agent a `name` only when it was started with one. Operators
 * often name the *tab* instead (`herdr tab rename w1:t1 sample#reviewer`),
 * and `agent.list` does not carry that label: only `tab.list` does. This
 * module joins the two, using Herdr's native API only. Terminal titles are
 * different metadata (the agent sets them, often to its current task) and are
 * never used as a name.
 */
import { isUnknownMethodError, type HerdrClient } from "../herdr/client.js";
import type { AgentInfo, TabInfo } from "../herdr/types.js";

/**
 * The label the operator gave a tab, or undefined when it has none. Herdr
 * reports an unlabelled tab with its number as the label (`"1"`), which is
 * not a name.
 */
export function operatorTabLabel(tab: TabInfo): string | undefined {
  const label = tab.label.trim();
  if (label === "") return undefined;
  if (typeof tab.number === "number" && label === String(tab.number)) return undefined;
  return label;
}

/**
 * Copies of `agents` with `tab_label` set from `tabs`, plus
 * `tab_label_tab_ids` when that label (case-insensitively) is on more than one
 * tab. Agents whose tab is unknown or unlabelled are returned unchanged, so a
 * missing `tab.list` degrades to the plain `agent.list` view.
 */
export function withTabLabels(agents: AgentInfo[], tabs: TabInfo[]): AgentInfo[] {
  const labelByTab = new Map<string, string>();
  const tabsByLabel = new Map<string, string[]>();
  for (const tab of tabs) {
    const label = operatorTabLabel(tab);
    if (label === undefined) continue;
    labelByTab.set(tab.tab_id, label);
    const key = label.toLowerCase();
    tabsByLabel.set(key, [...(tabsByLabel.get(key) ?? []), tab.tab_id]);
  }
  return agents.map((agent) => {
    const { tab_label: _stale, tab_label_tab_ids: _staleIds, ...rest } = agent;
    const label = labelByTab.get(agent.tab_id);
    if (label === undefined) return rest;
    const sharing = tabsByLabel.get(label.toLowerCase()) ?? [];
    return { ...rest, tab_label: label, ...(sharing.length > 1 ? { tab_label_tab_ids: sharing } : {}) };
  });
}

/** Name precedence for display: Herdr agent name, then tab label. Undefined when neither exists. */
export function agentDisplayName(agent: AgentInfo): string | undefined {
  return agent.name || agent.tab_label || undefined;
}

/**
 * `agent.list` enriched with tab labels from `tab.list`, fetched in parallel.
 *
 * Only a Herdr that does not know `tab.list` at all (an older server) means
 * "no labels". Every other failure propagates: a refusal such as
 * `permission_denied` or `internal_error`, and any transport failure, come
 * from the same server that has to answer `agent.list`, and hiding them would
 * report a healthy herd from a broken one.
 */
export async function listLabelledAgents(client: Pick<HerdrClient, "listAgents" | "listTabs">): Promise<AgentInfo[]> {
  const [agents, tabs] = await Promise.all([
    client.listAgents(),
    client.listTabs().catch((error: unknown) => {
      if (isUnknownMethodError(error, "tab.list")) return [];
      throw error;
    }),
  ]);
  return tabs.length === 0 ? agents : withTabLabels(agents, tabs);
}
