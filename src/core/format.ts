import type { AgentInfo, AgentStatus } from "../herdr/types.js";
import { compactPaneText, DEFAULT_MAX_CHARS, DEFAULT_MAX_LINE_CHARS } from "./compact.js";
import type { Messages, NotificationKind } from "./i18n.js";
import { agentDisplayName } from "./labels.js";
import { formatTargetRef } from "./parse.js";
import { LOCAL_SERVER_ID } from "./servers.js";
import { samePane, type SettledStatus, type WatchRecord } from "./watch-store.js";

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

/**
 * One agent as a chat line. `ref` is the pane reference the operator can
 * always copy back into a command: the bare pane id locally, `w1:p1@buildbox`
 * on a machine. When the agent has an operator-facing name (its Herdr name,
 * else its tab label) that name leads, carrying the same `@suffix`, and the
 * pane ref follows as the unambiguous secondary reference.
 */
export function formatAgentLine(m: Messages, agent: AgentInfo, ref: string = agent.pane_id, suffix?: string): string {
  const name = agentDisplayName(agent);
  const kind = agent.agent ?? m.noAgentKind;
  const head = name
    ? `**${formatTargetRef(displayLabel(name), suffix)}** ${kind} · ${ref}`
    : `**${ref}** ${kind}`;
  const cwd = agent.foreground_cwd ?? agent.cwd ?? "";
  const title = agent.terminal_title_stripped ? ` — ${preview(agent.terminal_title_stripped, TITLE_MAX_CHARS)}` : "";
  return `${STATUS_ICON[agent.agent_status] ?? "?"} ${head} · ${agent.agent_status}${title}${cwd ? `\n   ${shortenPath(cwd)}` : ""}`;
}

/** Name or kind for parentheses in chat: `(sample#reviewer)`, `(claude)`. */
export function agentLabel(agent: AgentInfo, fallback = "?"): string {
  return displayLabel(agentDisplayName(agent) ?? agent.agent ?? fallback);
}

/** A name that came from the operator: one bounded line that cannot break the bold around it. */
function displayLabel(name: string): string {
  return preview(name.replace(/[*`]/gu, ""), LABEL_MAX_CHARS);
}

/** The agents of one server. Local-only; {@link formatServerList} groups several. */
export function formatAgentList(
  m: Messages,
  agents: AgentInfo[],
  watches: WatchRecord[],
  serverId = LOCAL_SERVER_ID,
): string {
  const live = agents.filter((agent) => agent.agent !== null);
  if (live.length === 0) return m.noRunningAgent;
  return [m.agentsHeader, ...agentLines(m, live, watches, serverId, undefined)].join("\n");
}

/**
 * One server in `/herdr list`: its agents, or why they cannot be listed.
 * `down` is a short reason (`ssh authentication failed`), never a stack.
 */
export interface ServerGroup {
  id: string;
  label: string;
  isLocal: boolean;
  /** Undefined when the server could not be asked. */
  agents?: AgentInfo[];
  down?: string;
}

/**
 * `/herdr list` across servers: this host first, then one group header per
 * machine (`Machine buildbox:`) with copyable qualified refs. A machine that
 * cannot be pinged is one line with its reason, so the list still works when
 * half the herd is asleep.
 */
export function formatServerList(m: Messages, groups: ServerGroup[], watches: WatchRecord[], note?: string): string {
  const lines: string[] = [];
  const onlyLocal = groups.length === 1 && groups[0]?.isLocal === true;
  for (const group of groups) {
    const live = (group.agents ?? []).filter((agent) => agent.agent !== null);
    if (group.isLocal) {
      if (group.down) {
        // The local server is the plugin's floor: say what to check, not `down`.
        lines.push(m.cannotReachHerdr(group.down));
        continue;
      }
      if (live.length === 0 && onlyLocal) {
        lines.push(m.noRunningAgent);
        continue;
      }
      lines.push(m.agentsHeader);
      if (live.length === 0) lines.push(m.noAgentOnHost);
      else lines.push(...agentLines(m, live, watches, group.id, undefined));
      continue;
    }
    if (group.down) {
      lines.push(m.machineDown(group.label, group.down));
      continue;
    }
    lines.push(m.machineHeader(group.label));
    if (live.length === 0) lines.push(m.noAgentThere);
    else lines.push(...agentLines(m, live, watches, group.id, group.label));
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

function agentLines(
  m: Messages,
  live: AgentInfo[],
  watches: WatchRecord[],
  serverId: string,
  suffix: string | undefined,
): string[] {
  return live.map((agent) => {
    const ref = formatTargetRef(agent.pane_id, suffix);
    const watched = watches.some((watch) => samePane(watch, { serverId, paneId: agent.pane_id }));
    return formatAgentLine(m, agent, ref, suffix) + (watched ? `\n   ${m.watchingMark}` : "");
  });
}

/**
 * Outcome of a send, from the operator's point of view:
 *  - `watching`: delivered and tracked.
 *  - `off`: delivered, tracking not requested.
 *  - `tracking_failed`: delivered, but we cannot promise a notification.
 */
export type SendTracking = "watching" | "off" | "tracking_failed";

export function formatSendAccepted(
  m: Messages,
  agent: AgentInfo,
  text: string,
  tracking: SendTracking,
  ref: string = agent.pane_id,
): string {
  const note = tracking === "watching" ? m.trackingWatching : tracking === "off" ? m.trackingOff : m.trackingFailed;
  return [m.sentTo(ref, agentLabel(agent)), note, `> ${preview(text)}`].join("\n");
}

export function formatStatus(
  m: Messages,
  agent: AgentInfo,
  tail: string | undefined,
  watch: WatchRecord | undefined,
  ref: string = agent.pane_id,
  suffix?: string,
): string {
  const lines = [formatAgentLine(m, agent, ref, suffix)];
  if (watch) lines.push(m.watchingSince(watch.createdAt));
  const block = tail ? trimTail(tail, 14) : "";
  if (block) lines.push("", block);
  return lines.join("\n");
}

export function formatNotification(
  m: Messages,
  watch: WatchRecord,
  status: SettledStatus,
  tail: string | undefined,
  ref: string = watch.paneId,
): string {
  const who = `**${ref}** (${watch.agentLabel})`;
  const kind: NotificationKind =
    status === "blocked" || status === "exited" || status === "occupant_changed" || status === "timed_out"
      ? status
      : "finished";
  const parts = [m.notification(kind, who), `> ${preview(watch.promptPreview)}`];
  // Another terminal's output must not be shown as if it were the answer.
  const block = tail && status !== "occupant_changed" ? trimTail(tail, 20) : "";
  if (block) parts.push("", block);
  if (status === "blocked") {
    // Sends are refused while the agent is blocked, so do not promise a reply from chat.
    parts.push("", m.blockedAnswerHint, m.blockedReadHint(ref));
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
