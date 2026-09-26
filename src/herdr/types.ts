/**
 * Types for the subset of the Herdr socket API (protocol 22, Herdr 0.9.1)
 * that this plugin uses. Shapes come from `herdr api schema --json`.
 *
 * Herdr's own compatibility rule for JSON clients: ignore unknown fields and
 * treat unsupported methods as ordinary errors. We follow it, so nothing here
 * is pinned to an exact server version.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

export interface AgentInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  agent: string | null;
  display_agent?: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused: boolean;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  revision: number;
  state_change_seq?: number;
  interactive_ready?: boolean | null;
  /**
   * Plugin-side enrichment, never sent by Herdr: the operator-assigned label
   * of the agent's tab, from `tab.list`. Absent when the tab has no label of
   * its own or the server does not expose tab metadata.
   */
  tab_label?: string;
  /**
   * Plugin-side enrichment: every tab id carrying the same label
   * (case-insensitively), set only when there is more than one. Such a label
   * never selects a pane, whatever those tabs run.
   */
  tab_label_tab_ids?: string[];
}

/** One tab as `tab.list` reports it. An unlabelled tab reports its number as its label. */
export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
  number?: number;
  pane_count?: number;
  focused?: boolean;
}

/** One pane as `pane.list` reports it: a shell pane has `agent: null`. */
export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  label?: string | null;
  agent?: string | null;
  agent_status?: AgentStatus;
  cwd?: string | null;
  focused?: boolean;
}

export interface PaneProcessInfo {
  pane_id: string;
  shell_pid: number | null;
  foreground_processes: Array<{ pid: number; name: string }>;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: ReadSource;
  format: "text" | "ansi";
  text: string;
  revision: number;
  truncated: boolean;
}

export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export interface PingResult {
  type: "pong";
  version: string;
  protocol: number;
  capabilities?: Record<string, unknown>;
}

export interface AgentPromptWaitOptions {
  until?: AgentStatus[];
  timeout_ms?: number | null;
}

export interface HerdrError {
  code: string;
  message: string;
}

export type SubscriptionSpec =
  | { type: "pane.agent_status_changed"; pane_id: string; agent_status?: AgentStatus }
  | { type: "pane.agent_detected" }
  | { type: "pane.exited" }
  | { type: "pane.closed" };

export interface PaneAgentStatusChangedEvent {
  pane_id: string;
  workspace_id: string;
  agent: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  title?: string | null;
  state_labels?: Record<string, string>;
}

export interface SubscriptionEvent {
  event: string;
  data: Record<string, unknown>;
}
