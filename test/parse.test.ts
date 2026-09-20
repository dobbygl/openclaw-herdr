import { describe, expect, it } from "vitest";
import {
  commandErrorText,
  HELP_TEXT,
  MAX_READ_LINES,
  MIN_READ_LINES,
  parseHerdrCommand,
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
});
