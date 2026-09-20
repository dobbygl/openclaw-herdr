/**
 * Grammar of the `/herdr` chat command. Kept tiny and explicit so a phone
 * user can type it without looking anything up:
 *
 *   /herdr                      help
 *   /herdr list                 agents Herdr currently sees
 *   /herdr status [target]      state of one agent (or all)
 *   /herdr read <target> [N]    last N lines of that agent's pane (N: 1-400)
 *   /herdr watch <target>       wake me when it finishes or blocks
 *   /herdr unwatch <target>     stop watching
 *   /herdr <target>: <prompt>   send a prompt and watch it
 *   /herdr <prompt>             send to the only agent, if there is exactly one
 *
 * `list`, `status`, `read`, `watch` and `unwatch` (plus the aliases `ls`, `st`,
 * `tail`) are reserved heads: when one of them is used with missing or invalid
 * arguments the result is an `error` command carrying a one-line usage hint,
 * never a prompt sent to an agent. Prose that starts with a reserved word can
 * still be sent with the explicit form `/herdr <target>: read the README`.
 */
export type HerdrCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status"; target?: string }
  | { kind: "read"; target: string; lines?: number }
  | { kind: "watch"; target: string }
  | { kind: "unwatch"; target: string }
  | { kind: "send"; target?: string; text: string }
  | { kind: "error"; message: string };

const TARGET = /^[a-z][a-z0-9_:-]{0,40}$/iu;

/** Herdr's `agent.read` (and the herdr_read tool) accept 1-400 lines. */
export const MIN_READ_LINES = 1;
export const MAX_READ_LINES = 400;

const TARGET_HINT = "a pane id (w6:p1), an agent name, or an agent kind when unique (claude, codex)";

export function parseHerdrCommand(rawArgs: string | undefined): HerdrCommand {
  const args = (rawArgs ?? "").trim();
  if (args === "" || args === "help" || args === "?") return { kind: "help" };

  const [head = "", ...rest] = args.split(/\s+/u);
  const word = head.toLowerCase();
  const tail = rest.join(" ").trim();

  if (word === "list" || word === "ls") return { kind: "list" };

  if (word === "status" || word === "st") {
    if (tail === "") return { kind: "status" };
    if (TARGET.test(tail)) return { kind: "status", target: tail };
    return error(`"${tail}" is not a target. Usage: /herdr status [target] — ${TARGET_HINT}.`);
  }

  if (word === "read" || word === "tail") {
    const [target, count, ...extra] = rest;
    if (target === undefined) {
      return error(`Usage: /herdr read <target> [lines ${MIN_READ_LINES}-${MAX_READ_LINES}] — target is ${TARGET_HINT}.`);
    }
    if (!TARGET.test(target)) {
      return error(
        `"${target}" is not a target. Usage: /herdr read <target> [lines ${MIN_READ_LINES}-${MAX_READ_LINES}]; to send prose use /herdr <target>: ${args}.`,
      );
    }
    if (extra.length > 0) {
      return error(`Usage: /herdr read <target> [lines ${MIN_READ_LINES}-${MAX_READ_LINES}] — one target and one line count.`);
    }
    if (count === undefined) return { kind: "read", target };
    const lines = readLineCount(count);
    if (lines === undefined) {
      return error(`"${count}" is not a line count; use a whole number between ${MIN_READ_LINES} and ${MAX_READ_LINES}.`);
    }
    return { kind: "read", target, lines };
  }

  if (word === "watch" || word === "unwatch") {
    if (rest.length === 1 && TARGET.test(rest[0] ?? "")) return { kind: word, target: rest[0] as string };
    return error(
      rest.length === 0
        ? `Usage: /herdr ${word} <target> — ${TARGET_HINT}.`
        : `Usage: /herdr ${word} <target> — one target only; ${TARGET_HINT}.`,
    );
  }

  // "<target>: <prompt>" — the target ends at the first colon that is
  // followed by whitespace, so pane ids like w6:p1 keep their own colon.
  const targeted = /^([A-Za-z][\w:-]{0,40}):\s+(\S[\s\S]*)$/u.exec(args);
  if (targeted && TARGET.test(targeted[1] ?? "")) {
    return { kind: "send", target: targeted[1] as string, text: (targeted[2] as string).trim() };
  }
  return { kind: "send", text: args };
}

/** The one-line refusal of an `error` command, or undefined for every other command. */
export function commandErrorText(command: HerdrCommand): string | undefined {
  return command.kind === "error" ? command.message : undefined;
}

function error(message: string): HerdrCommand {
  return { kind: "error", message };
}

function readLineCount(raw: string): number | undefined {
  if (!/^\d{1,6}$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_READ_LINES || value > MAX_READ_LINES) return undefined;
  return value;
}

export const HELP_TEXT = [
  "Herdr commands:",
  "/herdr list — agents Herdr sees",
  "/herdr <target>: <prompt> — send and watch",
  "/herdr <prompt> — send to the only agent",
  "/herdr status [target]",
  `/herdr read <target> [lines ${MIN_READ_LINES}-${MAX_READ_LINES}]`,
  "/herdr watch <target> · /herdr unwatch <target>",
  `Targets: ${TARGET_HINT}; a pane id wins over a name, a name over a kind.`,
  "list/status/read/watch/unwatch are commands: to send a prompt that starts with one, use /herdr <target>: <prompt>.",
].join("\n");
