import { describe, expect, it } from "vitest";
import { parseHerdrCommand } from "../src/core/parse.js";

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
});
