import { describe, expect, it } from "vitest";
import {
  formatAgentLine,
  formatAgentList,
  formatNotification,
  formatSendAccepted,
  formatServerList,
  formatStatus,
  LABEL_MAX_CHARS,
  PANE_BLOCK_MAX_CHARS,
  PANE_LINE_MAX_CHARS,
  PATH_MAX_CHARS,
  preview,
  shortenPath,
  TITLE_MAX_CHARS,
  trimTail,
} from "../src/core/format.js";
import type { AgentInfo } from "../src/herdr/types.js";
import type { WatchRecord } from "../src/core/watch-store.js";

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  pane_id: "w6:p1",
  workspace_id: "w6",
  tab_id: "w6:t1",
  terminal_id: "term_1",
  agent: "claude",
  agent_status: "working",
  focused: false,
  revision: 1,
  ...over,
});

const watch = (over: Partial<WatchRecord> = {}): WatchRecord => ({
  id: "watch-1",
  serverId: "local",
  paneId: "w6:p1",
  terminalId: "term_1",
  agentLabel: "claude",
  sessionKey: "agent:main:telegram:1",
  promptPreview: "run the tests",
  createdAt: "2026-01-01T00:00:00.000Z",
  deadlineAt: "2026-01-01T12:00:00.000Z",
  seqAtStart: 1,
  sawWorking: true,
  notificationSeq: 1,
  ...over,
}) as WatchRecord;

describe("formatAgentLine", () => {
  it("shows icon, pane, label, state, title and shortened cwd", () => {
    const line = formatAgentLine(
      agent({
        name: "reviewer",
        agent_status: "blocked",
        terminal_title_stripped: "npm test",
        foreground_cwd: "/srv/build/proj",
      }),
    );
    // Split so the assertion never depends on the ambient $HOME that
    // formatAgentLine passes to shortenPath.
    const [first, second, ...others] = line.split("\n");
    expect(first).toBe("⚠ **reviewer** claude · w6:p1 · blocked — npm test");
    expect(second).toMatch(/^ {3}\S*build\/proj$/u);
    expect(others).toEqual([]);
  });
  it("falls back to the kind, then to no agent", () => {
    expect(formatAgentLine(agent())).toBe("● **w6:p1** claude · working");
    expect(formatAgentLine(agent({ agent: null, agent_status: "unknown" }))).toBe("? **w6:p1** no agent · unknown");
  });
  it("caps a hostile name and a novel-length terminal title", () => {
    const line = formatAgentLine(
      agent({ name: "n".repeat(500), terminal_title_stripped: "t".repeat(500), foreground_cwd: null }),
    );
    const [first = ""] = line.split("\n");
    expect(first).toContain("…");
    expect(first.length).toBeLessThanOrEqual(LABEL_MAX_CHARS + TITLE_MAX_CHARS + 40);
  });
  it("flattens newlines injected through the title", () => {
    const line = formatAgentLine(agent({ terminal_title_stripped: "evil\n**not a real line**" }));
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("formatAgentLine with a tab label", () => {
  it("leads with the label and keeps the pane id as the secondary ref", () => {
    expect(formatAgentLine(agent({ tab_label: "sample#reviewer", agent_status: "idle" }))).toBe(
      "○ **sample#reviewer** claude · w6:p1 · idle",
    );
  });
  it("prefers the Herdr agent name over the tab label", () => {
    expect(formatAgentLine(agent({ name: "reviewer", tab_label: "sample#reviewer" }))).toBe(
      "● **reviewer** claude · w6:p1 · working",
    );
  });
  it("qualifies both the name and the pane ref on a machine", () => {
    expect(formatAgentLine(agent({ tab_label: "sample#builder" }), "w6:p1@buildbox", "buildbox")).toBe(
      "● **sample#builder@buildbox** claude · w6:p1@buildbox · working",
    );
  });
  it("keeps a hostile label on one bounded line that cannot close the bold", () => {
    const line = formatAgentLine(agent({ tab_label: "a**b`c\nd" + "x".repeat(200) }));
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("● **abc dxxx")).toBe(true);
    expect(line).toContain("…** claude · w6:p1 · working");
  });
  it("names the label in the send receipt", () => {
    expect(formatSendAccepted(agent({ tab_label: "sample#reviewer" }), "run the tests", "off")).toContain(
      "Sent to **w6:p1** (sample#reviewer).",
    );
  });
  it("groups a machine's labelled agents with qualified refs", () => {
    const out = formatServerList(
      [
        { id: "local", label: "local", isLocal: true, agents: [agent({ tab_label: "sample#reviewer" })] },
        { id: "m1", label: "buildbox", isLocal: false, agents: [agent({ pane_id: "w1:p2", tab_label: "sample#builder" })] },
      ],
      [],
    );
    expect(out).toContain("**sample#reviewer** claude · w6:p1 · working");
    expect(out).toContain("**sample#builder@buildbox** claude · w1:p2@buildbox · working");
  });
});

describe("formatAgentList", () => {
  it("explains an empty herd", () => {
    expect(formatAgentList([], [])).toContain("no running coding agent");
    expect(formatAgentList([agent({ agent: null })], [])).toContain("no running coding agent");
  });
  it("lists live agents only and marks the watched ones", () => {
    const out = formatAgentList([agent(), agent({ pane_id: "w6:p2", agent: null }), agent({ pane_id: "w6:p3" })], [
      watch({ paneId: "w6:p3" }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Herdr agents:");
    expect(out).not.toContain("w6:p2");
    expect(out).toContain("w6:p3");
    expect(lines.at(-1)).toBe("   watching");
  });
});

describe("formatServerList", () => {
  const local = { id: "local", label: "local", isLocal: true };
  const buildbox = { id: "abc123", label: "buildbox", isLocal: false };
  const lab = { id: "ddd444", label: "lab", isLocal: false };

  it("groups the herd by machine with copyable refs", () => {
    const out = formatServerList(
      [
        { ...local, agents: [agent()] },
        { ...buildbox, agents: [agent({ pane_id: "w1:p1", agent: "codex", agent_status: "idle" })] },
        { ...lab, down: "ssh authentication failed" },
      ],
      [watch({ serverId: "abc123", paneId: "w1:p1" })],
    );
    expect(out.split("\n")).toEqual([
      "Herdr agents:",
      "● **w6:p1** claude · working",
      "Machine buildbox:",
      "○ **w1:p1@buildbox** codex · idle",
      "   watching",
      "Machine lab: down — ssh authentication failed",
    ]);
  });

  it("marks a watch on the right server only", () => {
    const groups = [
      { ...local, agents: [agent({ pane_id: "w1:p1" })] },
      { ...buildbox, agents: [agent({ pane_id: "w1:p1" })] },
    ];
    const out = formatServerList(groups, [watch({ serverId: "local", paneId: "w1:p1" })]);
    const lines = out.split("\n");
    expect(lines[2]).toBe("   watching");
    expect(lines.at(-1)).toBe("● **w1:p1@buildbox** claude · working");
  });

  it("says when a server has nothing running", () => {
    const out = formatServerList([{ ...local, agents: [] }, { ...buildbox, agents: [] }], []);
    expect(out).toContain("no agent on this host");
    expect(out).toContain("no agent there");
    // Only this host, and empty: the original sentence, with the hint.
    expect(formatServerList([{ ...local, agents: [] }], [])).toContain("Start claude or codex");
  });

  it("tells the operator what to check when the local server is down", () => {
    const out = formatServerList([{ ...local, down: "ENOENT" }, { ...buildbox, agents: [agent()] }], []);
    expect(out.split("\n")[0]).toBe("Cannot reach Herdr: ENOENT. Is the Herdr server running?");
    expect(out).toContain("Machine buildbox:");
  });

  it("appends a note about the machine list", () => {
    const out = formatServerList([{ ...local, agents: [agent()] }], [], "Machine list unavailable: herdr not found");
    expect(out.split("\n").at(-1)).toBe("Machine list unavailable: herdr not found");
  });
});

describe("preview", () => {
  it("flattens whitespace and caps the length", () => {
    expect(preview("  run\n\tthe   tests  ")).toBe("run the tests");
    const long = preview("x".repeat(400));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
  it("honours a custom ceiling", () => {
    expect(preview("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("trimTail", () => {
  it("wraps pane output in a fenced block", () => {
    expect(trimTail("hello\nworld", 10)).toBe("```\nhello\nworld\n```");
  });
  it("returns nothing when the pane has nothing to show", () => {
    expect(trimTail("❯ \n", 10)).toBe("");
    expect(trimTail("", 10)).toBe("");
  });
  it("neutralizes a fence in the pane text so the block cannot be closed early", () => {
    const block = trimTail("cat README.md\n```\ninside\n```", 10);
    expect(block.startsWith("```\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
    // Exactly the two fences we added, none from the pane text.
    expect(block.split("```")).toHaveLength(3);
    expect(block).toContain("ˋˋˋ");
  });
  it("keeps the block inside the default character budget", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `${i} ` + "x".repeat(80)).join("\n");
    const block = trimTail(huge, 400);
    expect(block).toContain("earlier lines omitted");
    expect(block.length).toBeLessThan(PANE_BLOCK_MAX_CHARS + 128);
  });
  it("accepts a tighter budget from the caller", () => {
    const huge = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const block = trimTail(huge, 40, { maxChars: 40 });
    expect(block).toContain("earlier lines omitted");
    expect(block.length).toBeLessThan(120);
  });
  it("truncates a very long single line", () => {
    const block = trimTail("z".repeat(2000), 10);
    const body = block.split("\n")[1] ?? "";
    expect(body).toHaveLength(PANE_LINE_MAX_CHARS);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("shortenPath", () => {
  it("collapses the home directory", () => {
    expect(shortenPath("/home/u/proj", "/home/u")).toBe("~/proj");
    expect(shortenPath("/srv/proj", "/home/u")).toBe("/srv/proj");
    expect(shortenPath("/srv/proj", "")).toBe("/srv/proj");
  });
  it("drops leading segments of an over-long path", () => {
    const deep = "/home/u/" + Array.from({ length: 20 }, (_, i) => `dir${i}`).join("/");
    const out = shortenPath(deep, "/home/u");
    expect(out.startsWith("…/")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(PATH_MAX_CHARS);
    expect(out.endsWith("/dir19")).toBe(true);
    // A path that already fits is left exactly as it is.
    expect(shortenPath("/home/u/" + "a".repeat(40), "/home/u")).toBe("~/" + "a".repeat(40));
  });
  it("truncates a single over-long segment", () => {
    const out = shortenPath("/" + "s".repeat(200), "");
    expect(out.startsWith("…")).toBe(true);
    expect(out).toHaveLength(PATH_MAX_CHARS);
  });
});

describe("formatSendAccepted", () => {
  it("names the pane, the watch state and the prompt", () => {
    expect(formatSendAccepted(agent({ name: "reviewer" }), "run  the tests", "watching")).toBe(
      ["Sent to **w6:p1** (reviewer).", "I will tell you when it finishes or needs input.", "> run the tests"].join("\n"),
    );
    expect(formatSendAccepted(agent(), "go", "off")).toContain("Not watching");
  });
});

describe("formatStatus", () => {
  it("adds the watch age and the pane tail", () => {
    const out = formatStatus(agent(), "working on it\n", watch());
    expect(out).toContain("watching since 2026-01-01T00:00:00.000Z");
    expect(out).toContain("```\nworking on it\n```");
  });
  it("omits the block when there is no output", () => {
    expect(formatStatus(agent(), undefined, undefined)).toBe("● **w6:p1** claude · working");
  });
});

describe("formatNotification", () => {
  it("announces the settled states", () => {
    expect(formatNotification(watch(), "done", undefined)).toContain("finished");
    expect(formatNotification(watch(), "idle", undefined)).toContain("finished");
    expect(formatNotification(watch(), "exited", undefined)).toContain("exited");
    expect(formatNotification(watch(), "timed_out", undefined)).toContain("watch deadline");
    expect(formatNotification(watch(), "done", undefined)).toContain("> run the tests");
  });
  it("tells the truth about answering a blocked prompt", () => {
    const out = formatNotification(watch(), "blocked", "Do you want to proceed?\n");
    expect(out).toContain("needs your input");
    expect(out).toContain("Answer it in the terminal (Herdr or Collie)");
    expect(out).toContain("/herdr read w6:p1");
    expect(out).toContain("not implemented yet");
    // It must not promise a send that the runtime refuses while blocked.
    expect(out).not.toMatch(/\/herdr <pane>: <text>/u);
    expect(out).not.toMatch(/send a reply/u);
  });
  it("adds the advice only when blocked", () => {
    expect(formatNotification(watch(), "done", "all green\n")).not.toContain("Answer it in the terminal");
  });
  it("bounds the pane tail it embeds", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `${i} ` + "x".repeat(300)).join("\n");
    const out = formatNotification(watch(), "done", huge);
    expect(out.length).toBeLessThan(PANE_BLOCK_MAX_CHARS + 256);
    expect(out).not.toMatch(/x{401}/u);
  });
});
