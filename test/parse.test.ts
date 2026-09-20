import { describe, expect, it } from "vitest";
import {
  commandErrorText,
  formatTargetRef,
  HELP_TEXT,
  MAX_READ_LINES,
  MIN_READ_LINES,
  parseHerdrCommand,
  parseTargetRef,
  TargetSyntaxError,
} from "../src/core/parse.js";

const errorOf = (args: string): string => {
  const command = parseHerdrCommand(args);
  expect(command.kind).toBe("error");
  return commandErrorText(command) ?? "";
};

describe("parseHerdrCommand", () => {
  it("maps bare and help forms", () => {
    expect(parseHerdrCommand(undefined)).toEqual({ kind: "help" });
    expect(parseHerdrCommand("  help ")).toEqual({ kind: "help" });
  });
  it("parses list, status, read, watch and unwatch", () => {
    expect(parseHerdrCommand("list")).toEqual({ kind: "list" });
    expect(parseHerdrCommand("status")).toEqual({ kind: "status" });
    expect(parseHerdrCommand("status w6:p1")).toEqual({ kind: "status", target: "w6:p1" });
    expect(parseHerdrCommand("read claude 30")).toEqual({ kind: "read", target: "claude", lines: 30 });
    expect(parseHerdrCommand("read w6:p1")).toEqual({ kind: "read", target: "w6:p1" });
    expect(parseHerdrCommand("watch reviewer")).toEqual({ kind: "watch", target: "reviewer" });
    expect(parseHerdrCommand("unwatch w6:p1")).toEqual({ kind: "unwatch", target: "w6:p1" });
  });
  it("parses targeted and untargeted sends", () => {
    expect(parseHerdrCommand("w6:p1: run the tests")).toEqual({ kind: "send", target: "w6:p1", text: "run the tests" });
    expect(parseHerdrCommand("claude: summarize: this repo")).toEqual({
      kind: "send",
      target: "claude",
      text: "summarize: this repo",
    });
    expect(parseHerdrCommand("run the tests and explain failures")).toEqual({
      kind: "send",
      text: "run the tests and explain failures",
    });
  });
  it("does not mistake prose with a colon for a target", () => {
    expect(parseHerdrCommand("Note: check the logs")).toEqual({ kind: "send", target: "Note", text: "check the logs" });
    expect(parseHerdrCommand("please do this: and that")).toEqual({ kind: "send", text: "please do this: and that" });
  });

  describe("read line counts", () => {
    it("accepts the whole supported range", () => {
      expect(parseHerdrCommand(`read w6:p1 ${MIN_READ_LINES}`)).toEqual({
        kind: "read",
        target: "w6:p1",
        lines: MIN_READ_LINES,
      });
      expect(parseHerdrCommand(`read w6:p1 ${MAX_READ_LINES}`)).toEqual({
        kind: "read",
        target: "w6:p1",
        lines: MAX_READ_LINES,
      });
    });
    it("rejects zero", () => {
      expect(errorOf("read w6:p1 0")).toContain("between 1 and 400");
    });
    it("rejects counts above the tool limit", () => {
      expect(errorOf("read w6:p1 401")).toContain("between 1 and 400");
      expect(errorOf("read w6:p1 9999")).toContain("between 1 and 400");
      expect(errorOf("read w6:p1 1000000")).toContain("not a line count");
    });
    it("rejects a count that is not a whole number", () => {
      expect(errorOf("read w6:p1 -5")).toContain("not a line count");
      expect(errorOf("read w6:p1 12.5")).toContain("not a line count");
      expect(errorOf("read w6:p1 all")).toContain("not a line count");
    });
    it("rejects extra words after the count", () => {
      expect(errorOf("read w6:p1 20 please")).toContain("one target and one line count");
    });
  });

  describe("incomplete reserved commands become errors", () => {
    it("read without a target", () => {
      expect(errorOf("read")).toContain("Usage: /herdr read <target>");
      expect(errorOf("tail")).toContain("Usage: /herdr read <target>");
    });
    it("read with an unusable target points at the send form", () => {
      const message = errorOf("read ../etc/passwd 10");
      expect(message).toContain("is not a target");
      expect(message).toContain("/herdr <target>:");
    });
    it("watch and unwatch without exactly one target", () => {
      expect(errorOf("watch")).toContain("Usage: /herdr watch <target>");
      expect(errorOf("unwatch")).toContain("Usage: /herdr unwatch <target>");
      expect(errorOf("watch w6:p1 w6:p2")).toContain("one target only");
      expect(errorOf("watch ???")).toContain("Usage: /herdr watch <target>");
    });
    it("status with an invalid target", () => {
      expect(errorOf("status ???")).toContain("Usage: /herdr status [target]");
      expect(errorOf("status w6:p1 and w6:p2")).toContain("is not a target");
    });
    it("carries a single-line message", () => {
      for (const args of ["read", "watch", "unwatch", "status ???", "read w6:p1 0"]) {
        expect(errorOf(args)).not.toContain("\n");
      }
    });
  });

  it("keeps prose sends working, including reserved words inside a prompt", () => {
    expect(parseHerdrCommand("listen to the failing test first")).toEqual({
      kind: "send",
      text: "listen to the failing test first",
    });
    expect(parseHerdrCommand("w6:p1: read the README and summarize it")).toEqual({
      kind: "send",
      target: "w6:p1",
      text: "read the README and summarize it",
    });
    expect(parseHerdrCommand("w6:p1: status")).toEqual({ kind: "send", target: "w6:p1", text: "status" });
  });

  it("commandErrorText only speaks for error commands", () => {
    expect(commandErrorText({ kind: "help" })).toBeUndefined();
    expect(commandErrorText({ kind: "send", text: "hi" })).toBeUndefined();
    expect(commandErrorText({ kind: "error", message: "nope" })).toBe("nope");
  });

  it("documents the read range and the reserved words in the help text", () => {
    expect(HELP_TEXT).toContain(`lines ${MIN_READ_LINES}-${MAX_READ_LINES}`);
    expect(HELP_TEXT).toContain("/herdr <target>: <prompt>");
  });

  it("documents @server targets in the help text, short and phone-friendly", () => {
    expect(HELP_TEXT).toContain("@machine");
    expect(HELP_TEXT).toContain("buildbox");
    const serverLine = HELP_TEXT.split("\n").find((line) => line.includes("@machine"));
    expect(serverLine?.length).toBeLessThan(70);
  });

  describe("selector@server targets", () => {
    it("parses suffixed targets for status, read, watch and unwatch", () => {
      expect(parseHerdrCommand("status w9:p1@buildbox")).toEqual({ kind: "status", target: "w9:p1@buildbox" });
      expect(parseHerdrCommand("read reviewer@buildbox 30")).toEqual({
        kind: "read",
        target: "reviewer@buildbox",
        lines: 30,
      });
      expect(parseHerdrCommand("read claude@buildbox")).toEqual({ kind: "read", target: "claude@buildbox" });
      expect(parseHerdrCommand("watch w9:p1@buildbox")).toEqual({ kind: "watch", target: "w9:p1@buildbox" });
      expect(parseHerdrCommand("unwatch w9:p1@buildbox")).toEqual({ kind: "unwatch", target: "w9:p1@buildbox" });
    });

    it("parses a suffixed target on the send form, splitting on the first colon-space", () => {
      expect(parseHerdrCommand("w9:p1@buildbox: run the tests")).toEqual({
        kind: "send",
        target: "w9:p1@buildbox",
        text: "run the tests",
      });
      expect(parseHerdrCommand("reviewer@buildbox: run the tests")).toEqual({
        kind: "send",
        target: "reviewer@buildbox",
        text: "run the tests",
      });
      expect(parseHerdrCommand("claude@buildbox: run the tests")).toEqual({
        kind: "send",
        target: "claude@buildbox",
        text: "run the tests",
      });
    });
  });

  describe("parseTargetRef", () => {
    it("splits a bare selector with no server", () => {
      expect(parseTargetRef("claude")).toEqual({ selector: "claude" });
      expect(parseTargetRef("w9:p1")).toEqual({ selector: "w9:p1" });
    });

    it("splits on the LAST @", () => {
      expect(parseTargetRef("w9:p1@buildbox")).toEqual({ selector: "w9:p1", server: "buildbox" });
      expect(parseTargetRef("reviewer@buildbox")).toEqual({ selector: "reviewer", server: "buildbox" });
    });

    it("rejects an empty selector", () => {
      expect(() => parseTargetRef("@buildbox")).toThrow(TargetSyntaxError);
    });

    it("rejects an empty server", () => {
      expect(() => parseTargetRef("w9:p1@")).toThrow(TargetSyntaxError);
    });

    it("rejects a server with characters that do not belong in a machine label", () => {
      expect(() => parseTargetRef("w9@x:p1")).toThrow(TargetSyntaxError);
    });

    it("rejects a target with an @ still inside the selector after splitting on the last one", () => {
      // Splitting "a@b@lab" on the LAST @ leaves selector "a@b", server "lab".
      // A first-@ split would instead give selector "a", server "b@lab" (also
      // invalid, but for a different reason: a bad server, not a bad
      // selector). Assert the selector-shaped complaint to pin down which
      // split rule is in effect.
      expect(() => parseTargetRef("a@b@lab")).toThrow(/selector/i);
      expect(() => parseTargetRef("a@b@lab")).toThrow(TargetSyntaxError);
    });

    it("throws a one-line message", () => {
      for (const bad of ["@buildbox", "w9:p1@", "w9@x:p1", "a@b@lab"]) {
        try {
          parseTargetRef(bad);
          expect.unreachable(`expected ${bad} to throw`);
        } catch (error) {
          expect(error).toBeInstanceOf(TargetSyntaxError);
          expect((error as Error).message).not.toContain("\n");
        }
      }
    });
  });

  describe("formatTargetRef", () => {
    it("round-trips through parseTargetRef", () => {
      for (const target of ["claude", "w9:p1", "w9:p1@buildbox", "reviewer@lab"]) {
        const ref = parseTargetRef(target);
        expect(formatTargetRef(ref.selector, ref.server)).toBe(target);
      }
    });

    it("omits the @server suffix when there is no server", () => {
      expect(formatTargetRef("claude")).toBe("claude");
      expect(formatTargetRef("claude", undefined)).toBe("claude");
    });

    it("adds the @server suffix when there is one", () => {
      expect(formatTargetRef("w9:p1", "buildbox")).toBe("w9:p1@buildbox");
    });
  });
});

describe("parseHerdrCommand start", () => {
  it("mirrors herdr agent start flags", () => {
    expect(parseHerdrCommand("start cuento")).toEqual({ kind: "start", name: "cuento", agentKind: "claude" });
    expect(parseHerdrCommand("start reviewer --kind codex")).toEqual({ kind: "start", name: "reviewer", agentKind: "codex" });
    expect(parseHerdrCommand("start reviewer --kind=codex --pane w1:p2 --cwd ~/project --timeout 45000")).toEqual({
      kind: "start",
      name: "reviewer",
      agentKind: "codex",
      paneId: "w1:p2",
      cwd: "~/project",
      timeoutMs: 45_000,
    });
    expect(parseHerdrCommand("start writer --kind claude -- --model sonnet --verbose")).toEqual({
      kind: "start",
      name: "writer",
      agentKind: "claude",
      agentArgs: ["--model", "sonnet", "--verbose"],
    });
    expect(parseHerdrCommand("start writer@buildbox --kind codex")).toEqual({ kind: "start", name: "writer@buildbox", agentKind: "codex" });
  });
  it("rejects bad names, unknown flags and bad values", () => {
    expect(parseHerdrCommand("start").kind).toBe("error");
    expect(parseHerdrCommand("start Cuento").kind).toBe("error");
    expect(parseHerdrCommand("start cuento codex").kind).toBe("error");
    expect(parseHerdrCommand("start cuento --pane nope").kind).toBe("error");
    expect(parseHerdrCommand("start cuento --timeout 10").kind).toBe("error");
    expect(parseHerdrCommand("start cuento --kind").kind).toBe("error");
  });
});
