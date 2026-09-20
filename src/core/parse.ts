/**
 * Grammar of the `/herdr` chat command. Kept tiny and explicit so a phone
 * user can type it without looking anything up:
 *
 *   /herdr                      help
 *   /herdr list                 agents Herdr currently sees
 *   /herdr status [target]      state of one agent (or all)
 *   /herdr read <target> [N]    last N lines of that agent's pane
 *   /herdr watch <target>       wake me when it finishes or blocks
 *   /herdr unwatch <target>     stop watching
 *   /herdr <target>: <prompt>   send a prompt and watch it
 *   /herdr <prompt>             send to the only agent, if there is exactly one
 */
export type HerdrCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status"; target?: string }
  | { kind: "read"; target: string; lines?: number }
  | { kind: "watch"; target: string }
  | { kind: "unwatch"; target: string }
  | { kind: "send"; target?: string; text: string };

const TARGET = /^[a-z][a-z0-9_:-]{0,40}$/iu;

export function parseHerdrCommand(rawArgs: string | undefined): HerdrCommand {
  const args = (rawArgs ?? "").trim();
  if (args === "" || args === "help" || args === "?") return { kind: "help" };

  const [head = "", ...rest] = args.split(/\s+/u);
  const word = head.toLowerCase();
  const tail = rest.join(" ").trim();

  if (word === "list" || word === "ls") return { kind: "list" };
  if (word === "status" || word === "st") {
    return tail && TARGET.test(tail) ? { kind: "status", target: tail } : { kind: "status" };
  }
  if (word === "read" || word === "tail") {
    const [target = "", count] = rest;
    if (!TARGET.test(target)) return { kind: "send", text: args };
    const lines = count !== undefined && /^\d{1,4}$/u.test(count) ? Number(count) : undefined;
    return lines === undefined ? { kind: "read", target } : { kind: "read", target, lines };
  }
  if ((word === "watch" || word === "unwatch") && rest.length === 1 && TARGET.test(rest[0] ?? "")) {
    return { kind: word, target: rest[0] as string };
  }

  // "<target>: <prompt>" — the target ends at the first colon that is
  // followed by whitespace, so pane ids like w6:p1 keep their own colon.
  const targeted = /^([A-Za-z][\w:-]{0,40}):\s+(\S[\s\S]*)$/u.exec(args);
  if (targeted && TARGET.test(targeted[1] ?? "")) {
    return { kind: "send", target: targeted[1] as string, text: (targeted[2] as string).trim() };
  }
  return { kind: "send", text: args };
}

export const HELP_TEXT = [
  "Herdr commands:",
  "/herdr list — agents Herdr sees",
  "/herdr <target>: <prompt> — send and watch",
  "/herdr <prompt> — send to the only agent",
  "/herdr status [target]",
  "/herdr read <target> [lines]",
  "/herdr watch <target> · /herdr unwatch <target>",
  "Targets: pane id (w6:p1), agent name, or agent kind when unique (claude, codex).",
].join("\n");
