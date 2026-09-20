import { describe, expect, it } from "vitest";
import {
  compactPaneText,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_LINE_CHARS,
} from "../src/core/compact.js";

const frame = [
  "  The three failing tests were caused by a stale fixture; I regenerated",
  "  it and the suite is green again.",
  "",
  "✻ Cogitated for 21s · done 1:13 PM",
  "                                                                               new task? /clear to save 12.3k tokens",
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  alice@example-host /home/user/project",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  "",
].join("\n");

describe("compactPaneText", () => {
  it("drops the composer chrome and footer at the bottom", () => {
    const out = compactPaneText(frame);
    expect(out).not.toMatch(/bypass permissions|example-host|new task\?/u);
    expect(out.endsWith("Cogitated for 21s · done 1:13 PM")).toBe(true);
  });
  it("shortens box-drawing dividers and collapses blank runs", () => {
    const out = compactPaneText("a\n" + "─".repeat(100) + "\n" + "─".repeat(100) + "\n\n\n\nb\n");
    expect(out).toBe("a\n───\nb");
  });
  it("dedents right-aligned hints but keeps code indentation", () => {
    const out = compactPaneText("    if (x) {\n" + " ".repeat(60) + "hint\n" + "done");
    expect(out).toBe("    if (x) {\n  hint\ndone");
  });
  it("keeps the prompt box when there is real draft text above the footer", () => {
    const out = compactPaneText("❯ some draft\n" + "─".repeat(50) + "\n  ⏸ manual mode on · ? for shortcuts");
    expect(out).toBe("❯ some draft");
  });
  it("limits the number of lines", () => {
    const out = compactPaneText(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"), { maxLines: 3 });
    expect(out).toBe("l47\nl48\nl49");
  });

  describe("character budget", () => {
    const wide = (count: number, width = 100): string =>
      Array.from({ length: count }, (_, i) => String(i).padEnd(width, "x")).join("\n");

    it("drops the oldest lines and says how many", () => {
      const out = compactPaneText(wide(10), { maxLines: 50, maxChars: 300 });
      const lines = out.split("\n");
      expect(lines[0]).toBe("… (8 earlier lines omitted)");
      expect(lines).toHaveLength(3);
      expect(lines[1]?.startsWith("8")).toBe(true);
      expect(lines[2]?.startsWith("9")).toBe(true);
      expect(out.length - (lines[0]?.length ?? 0) - 1).toBeLessThanOrEqual(300);
    });
    it("uses the singular when exactly one line is dropped", () => {
      const out = compactPaneText(wide(3), { maxLines: 50, maxChars: 210 });
      expect(out.split("\n")[0]).toBe("… (1 earlier line omitted)");
    });
    it("stays silent when everything fits", () => {
      const out = compactPaneText(wide(3), { maxLines: 50, maxChars: DEFAULT_MAX_CHARS });
      expect(out).not.toContain("omitted");
      expect(out.split("\n")).toHaveLength(3);
    });
    it("defaults to 3000 characters", () => {
      const out = compactPaneText(wide(200), { maxLines: 200 });
      expect(out).toContain("earlier lines omitted");
      expect(out.length).toBeLessThan(DEFAULT_MAX_CHARS + 64);
    });
    it("always keeps the newest line, even when it alone busts the budget", () => {
      const out = compactPaneText("old line\n" + "y".repeat(120), { maxLines: 50, maxChars: 10 });
      expect(out).toBe("… (1 earlier line omitted)\n" + "y".repeat(120));
    });
    it("does not count lines dropped by maxLines, which are already silent", () => {
      const out = compactPaneText(wide(10), { maxLines: 2, maxChars: DEFAULT_MAX_CHARS });
      expect(out).not.toContain("omitted");
    });
  });

  describe("long single lines", () => {
    it("truncates at 400 characters with an ellipsis", () => {
      const out = compactPaneText("head\n" + "z".repeat(900));
      const last = out.split("\n").at(-1) ?? "";
      expect(last).toHaveLength(DEFAULT_MAX_LINE_CHARS);
      expect(last.endsWith("…")).toBe(true);
      expect(last.startsWith("zzz")).toBe(true);
    });
    it("honours a custom line ceiling and leaves shorter lines alone", () => {
      const out = compactPaneText("abcdefghij\nshort", { maxLineChars: 5 });
      expect(out).toBe("abcd…\nshort");
    });
  });

  describe("fence neutralization", () => {
    it("replaces triple backticks so a stray fence cannot close the block", () => {
      const out = compactPaneText("before\n```ts\nconst x = 1;\n```\nafter");
      expect(out).not.toContain("```");
      expect(out).toContain("ˋˋˋts");
      expect(out.split("\n")).toEqual(["before", "ˋˋˋts", "const x = 1;", "ˋˋˋ", "after"]);
    });
    it("neutralizes longer runs too and keeps inline code intact", () => {
      expect(compactPaneText("a ````` b")).toBe("a ˋˋˋˋˋ b");
      expect(compactPaneText("use `npm test` and ``x``")).toBe("use `npm test` and ``x``");
    });
  });
});
