import { describe, expect, it } from "vitest";
import { compactPaneText } from "../src/core/compact.js";

const frame = [
  "  Si quieres comprobarlo tú mismo en la interfaz, cualquier ficha",
  "  logotipo.",
  "",
  "✻ Cogitated for 21s · done 1:13 PM",
  "                                                                               new task? /clear to save 335.8k tokens",
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
});
