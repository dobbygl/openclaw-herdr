import type { AgentInfo, AgentStatus } from "../herdr/types.js";
import { compactPaneText } from "./compact.js";
import type { SettledStatus, WatchRecord } from "./watch-store.js";

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: "○",
  working: "●",
  blocked: "⚠",
  done: "✓",
  unknown: "?",
};

export function formatAgentLine(agent: AgentInfo): string {
  const label = agent.name ? `${agent.name} (${agent.agent ?? "?"})` : (agent.agent ?? "no agent");
  const cwd = agent.foreground_cwd ?? agent.cwd ?? "";
  const title = agent.terminal_title_stripped ? ` — ${agent.terminal_title_stripped}` : "";
  return `${STATUS_ICON[agent.agent_status] ?? "?"} **${agent.pane_id}** ${label} · ${agent.agent_status}${title}${cwd ? `\n   ${shortenPath(cwd)}` : ""}`;
}

export function formatAgentList(agents: AgentInfo[], watches: WatchRecord[]): string {
  const live = agents.filter((agent) => agent.agent !== null);
  if (live.length === 0) return "Herdr sees no running coding agent. Start claude or codex inside a Herdr pane.";
  const watched = new Set(watches.map((watch) => watch.paneId));
  const lines = live.map((agent) => formatAgentLine(agent) + (watched.has(agent.pane_id) ? "\n   watching" : ""));
  return ["Herdr agents:", ...lines].join("\n");
}

/**
 * Outcome of a send, from the operator's point of view:
 *  - `watching`: delivered and tracked.
 *  - `off`: delivered, tracking not requested.
 *  - `tracking_failed`: delivered, but we cannot promise a notification.
 */
export type SendTracking = "watching" | "off" | "tracking_failed";

export function formatSendAccepted(agent: AgentInfo, text: string, tracking: SendTracking): string {
  const note =
    tracking === "watching"
      ? "I will tell you when it finishes or needs input."
      : tracking === "off"
        ? "Not watching; use /herdr status to check."
        : "It was delivered, but I could not set up the watch, so I will not be able to tell you when it finishes; use /herdr status.";
  return [`Sent to **${agent.pane_id}** (${agent.name ?? agent.agent ?? "?"}).`, note, `> ${preview(text)}`].join("\n");
}

export function formatStatus(agent: AgentInfo, tail: string | undefined, watch: WatchRecord | undefined): string {
  const lines = [formatAgentLine(agent)];
  if (watch) lines.push(`watching since ${watch.createdAt}`);
  const block = tail ? trimTail(tail, 14) : "";
  if (block) lines.push("", block);
  return lines.join("\n");
}

export function formatNotification(watch: WatchRecord, status: SettledStatus, tail: string | undefined): string {
  const who = `**${watch.paneId}** (${watch.agentLabel})`;
  const headline =
    status === "blocked"
      ? `Herdr: ${who} needs your input.`
      : status === "exited"
        ? `Herdr: ${who} exited.`
        : status === "occupant_changed"
          ? `Herdr: ${who} is gone; that pane runs something else now, so I stopped watching it.`
          : status === "timed_out"
            ? `Herdr: ${who} is still not finished after the watch deadline.`
            : `Herdr: ${who} finished.`;
  const parts = [headline, `> ${preview(watch.promptPreview)}`];
  // Another terminal's output must not be shown as if it were the answer.
  const block = tail && status !== "occupant_changed" ? trimTail(tail, 20) : "";
  if (block) parts.push("", block);
  if (status === "blocked") parts.push("", "Answer it in the terminal, or send a reply with /herdr <pane>: <text>.");
  return parts.join("\n");
}

export function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function trimTail(text: string, maxLines: number): string {
  const compact = compactPaneText(text, { maxLines });
  return compact ? "```\n" + compact + "\n```" : "";
}

export function shortenPath(cwd: string, home = process.env.HOME ?? ""): string {
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}
