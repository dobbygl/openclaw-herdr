import type { AgentInfo, AgentStatus } from "../herdr/types.js";
import { compactPaneText, DEFAULT_MAX_CHARS, DEFAULT_MAX_LINE_CHARS } from "./compact.js";
import type { SettledStatus, WatchRecord } from "./watch-store.js";

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: "○",
  working: "●",
  blocked: "⚠",
  done: "✓",
  unknown: "?",
};

/** Text limits. Chat is read on a phone, so every variable-length field has a ceiling. */
export const PANE_BLOCK_MAX_CHARS = DEFAULT_MAX_CHARS;
export const PANE_LINE_MAX_CHARS = DEFAULT_MAX_LINE_CHARS;
export const PREVIEW_MAX_CHARS = 160;
export const LABEL_MAX_CHARS = 60;
export const TITLE_MAX_CHARS = 80;
export const PATH_MAX_CHARS = 64;

export interface PaneBlockOptions {
  /** Character budget for the fenced block. Default 3000. */
  maxChars?: number;
  /** Ceiling for one line inside the block. Default 400. */
  maxLineChars?: number;
}

export function formatAgentLine(agent: AgentInfo): string {
  const raw = agent.name ? `${agent.name} (${agent.agent ?? "?"})` : (agent.agent ?? "no agent");
  const label = preview(raw, LABEL_MAX_CHARS);
  const cwd = agent.foreground_cwd ?? agent.cwd ?? "";
  const title = agent.terminal_title_stripped ? ` — ${preview(agent.terminal_title_stripped, TITLE_MAX_CHARS)}` : "";
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
  return [`Sent to **${agent.pane_id}** (${preview(agent.name ?? agent.agent ?? "?", LABEL_MAX_CHARS)}).`, note, `> ${preview(text)}`].join("\n");
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
  if (status === "blocked") {
    // Sends are refused while the agent is blocked, so do not promise a reply from chat.
    parts.push(
      "",
      "Answer it in the terminal (Herdr or Collie): I cannot answer a prompt for you while the agent is blocked.",
      `/herdr read ${watch.paneId} shows the prompt again. Answering from chat is not implemented yet.`,
    );
  }
  return parts.join("\n");
}

export function preview(text: string, max = PREVIEW_MAX_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Pane output as a fenced block, bounded in lines, characters and line length. */
export function trimTail(text: string, maxLines: number, options: PaneBlockOptions = {}): string {
  const compact = compactPaneText(text, {
    maxLines,
    maxChars: options.maxChars ?? PANE_BLOCK_MAX_CHARS,
    maxLineChars: options.maxLineChars ?? PANE_LINE_MAX_CHARS,
  });
  return compact ? "```\n" + compact + "\n```" : "";
}

export function shortenPath(cwd: string, home = process.env.HOME ?? "", max = PATH_MAX_CHARS): string {
  const short = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  if (short.length <= max) return short;
  const segments = short.split("/").filter((segment) => segment !== "");
  const kept: string[] = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as string;
    if ([segment, ...kept].join("/").length + 2 > max) break;
    kept.unshift(segment);
  }
  if (kept.length === 0) return "…" + short.slice(short.length - (max - 1));
  return "…/" + kept.join("/");
}
