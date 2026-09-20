import type { AgentInfo, AgentStatus } from "../herdr/types.js";
import type { WatchRecord } from "./watch-store.js";

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
  return `${STATUS_ICON[agent.agent_status] ?? "?"} ${agent.pane_id}  ${label}  ${agent.agent_status}${title}${cwd ? `\n   ${cwd}` : ""}`;
}

export function formatAgentList(agents: AgentInfo[], watches: WatchRecord[]): string {
  const live = agents.filter((agent) => agent.agent !== null);
  if (live.length === 0) return "Herdr sees no running coding agent. Start claude or codex inside a Herdr pane.";
  const watched = new Set(watches.map((watch) => watch.paneId));
  const lines = live.map((agent) => formatAgentLine(agent) + (watched.has(agent.pane_id) ? "\n   watching" : ""));
  return ["Herdr agents:", ...lines].join("\n");
}

export function formatSendAccepted(agent: AgentInfo, text: string, watching: boolean): string {
  return [
    `Sent to ${agent.pane_id} (${agent.name ?? agent.agent ?? "?"}).`,
    watching ? "I will tell you when it finishes or needs input." : "Not watching; use /herdr status to check.",
    `> ${preview(text)}`,
  ].join("\n");
}

export function formatStatus(agent: AgentInfo, tail: string | undefined, watch: WatchRecord | undefined): string {
  const lines = [formatAgentLine(agent)];
  if (watch) lines.push(`watching since ${watch.createdAt}`);
  if (tail && tail.trim()) lines.push("", trimTail(tail, 12));
  return lines.join("\n");
}

export function formatNotification(
  watch: WatchRecord,
  status: AgentStatus | "exited" | "timed_out",
  tail: string | undefined,
): string {
  const who = `${watch.paneId} (${watch.agentLabel})`;
  const headline =
    status === "blocked"
      ? `Herdr: ${who} needs your input.`
      : status === "exited"
        ? `Herdr: ${who} exited.`
        : status === "timed_out"
          ? `Herdr: ${who} is still not finished after the watch deadline.`
          : `Herdr: ${who} finished.`;
  const parts = [headline, `> ${preview(watch.promptPreview)}`];
  if (tail && tail.trim()) parts.push("", trimTail(tail, 20));
  if (status === "blocked") parts.push("", "Answer it in the terminal, or send a reply with /herdr <pane>: <text>.");
  return parts.join("\n");
}

export function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function trimTail(text: string, maxLines: number): string {
  const lines = text.replace(/\r/gu, "").split("\n");
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const kept = lines.slice(-maxLines);
  return "```\n" + kept.join("\n") + "\n```";
}
