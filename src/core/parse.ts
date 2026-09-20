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
 *
 * A target may carry a trailing `@<server>` naming a saved Herdr machine,
 * e.g. `w9:p1@buildbox`; see {@link parseTargetRef}.
 */
export type HerdrCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status"; target?: string }
  | { kind: "read"; target: string; lines?: number }
  | { kind: "watch"; target: string }
  | { kind: "unwatch"; target: string }
  | { kind: "send"; target?: string; text: string }
  | {
      kind: "start";
      name: string;
      agentKind: string;
      paneId?: string;
      cwd?: string;
      timeoutMs?: number;
      agentArgs?: string[];
    }
  | { kind: "error"; message: string };

/** Herdr's own rule for live agent names. An optional `@server` may follow. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;
/** Kinds Herdr 0.9 can start; kept as a hint, Herdr is the authority. */
export const KNOWN_AGENT_KINDS = ["claude", "codex", "gemini", "pi", "opencode", "copilot", "cursor", "kimi", "amp", "grok"] as const;
const DEFAULT_AGENT_KIND = "claude";

/**
 * A bare selector (pane id, terminal id, agent name or agent kind) may carry
 * a trailing `@<server>` naming a saved Herdr machine, e.g. `w9:p1@buildbox`,
 * `reviewer@buildbox`, `claude@buildbox`. `<server>` is a Herdr machine label
 * or profile id: it must start with an alphanumeric and may continue with
 * alphanumerics, `.`, `_` or `-`.
 */
const SELECTOR_SOURCE = "[a-z][a-z0-9_:-]{0,40}";
const SERVER_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const TARGET = new RegExp(`^${SELECTOR_SOURCE}(?:@${SERVER_SOURCE})?$`, "iu");

/** Herdr's `agent.read` (and the herdr_read tool) accept 1-400 lines. */
export const MIN_READ_LINES = 1;
export const MAX_READ_LINES = 400;

const TARGET_HINT = "a pane id (w6:p1), an agent name, or an agent kind when unique (claude, codex)";

/** Thrown by {@link parseTargetRef} for a target that cannot be split into a selector and an optional server. */
export class TargetSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetSyntaxError";
  }
}

/**
 * Splits a target string on its LAST `@` into a selector and an optional
 * server. `w9:p1@buildbox` → `{ selector: "w9:p1", server: "buildbox" }`;
 * `claude` → `{ selector: "claude" }`. An empty selector, an empty server, or
 * a selector that still contains `@` (more than one `@` in the target) is a
 * syntax error, not a resolution failure.
 */
export function parseTargetRef(target: string): { selector: string; server?: string } {
  const at = target.lastIndexOf("@");
  if (at === -1) {
    if (target === "") throw new TargetSyntaxError(`"${target}" is not a target: it is empty.`);
    return { selector: target };
  }
  const selector = target.slice(0, at);
  const server = target.slice(at + 1);
  if (selector === "") throw new TargetSyntaxError(`"${target}" is not a target: the selector before "@" is empty.`);
  if (selector.includes("@")) {
    throw new TargetSyntaxError(`"${target}" is not a target: a selector cannot contain "@".`);
  }
  if (server === "" || !new RegExp(`^${SERVER_SOURCE}$`, "u").test(server)) {
    throw new TargetSyntaxError(`"${target}" is not a target: "@${server}" is not a valid machine suffix.`);
  }
  return { selector, server };
}

/** The inverse of {@link parseTargetRef}: `selector` alone, or `selector@server`. */
export function formatTargetRef(selector: string, server?: string): string {
  return server ? `${selector}@${server}` : selector;
}

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

  if (word === "start") {
    // Mirrors `herdr agent start <name> --kind <kind> --pane <id> [--timeout <ms>] [-- <agent args>]`,
    // plus `--cwd <path>` (Herdr takes it from `tab create` when no pane is given).
    const usage = "Usage: /herdr start <name> --kind <kind> [--pane <id>] [--cwd <path>] [--timeout <ms>] [-- <agent args>]";
    const [rawName, ...flags] = rest;
    if (rawName === undefined || rawName.startsWith("-")) return error(`${usage} — e.g. /herdr start reviewer --kind codex --cwd ~/project.`);
    const at = rawName.lastIndexOf("@");
    const bareName = at > 0 ? rawName.slice(0, at) : rawName;
    const server = at > 0 ? rawName.slice(at + 1) : undefined;
    if (!AGENT_NAME.test(bareName) || (server !== undefined && !new RegExp(`^${SERVER_SOURCE}$`, "u").test(server))) {
      return error(`"${rawName}" is not a usable agent name: lowercase letters, digits, "_" or "-", up to 32 characters, optionally @machine.`);
    }
    let agentKind: string | undefined;
    let paneId: string | undefined;
    let cwd: string | undefined;
    let timeoutMs: number | undefined;
    let agentArgs: string[] | undefined;
    for (let i = 0; i < flags.length; i += 1) {
      const token = flags[i] as string;
      if (token === "--") {
        agentArgs = flags.slice(i + 1);
        break;
      }
      const eq = token.startsWith("--") ? token.indexOf("=") : -1;
      const flag = eq > 0 ? token.slice(0, eq) : token;
      const inline = eq > 0 ? token.slice(eq + 1) : undefined;
      const takeValue = (): string | undefined => {
        if (inline !== undefined) return inline;
        const next = flags[i + 1];
        if (next === undefined || next === "--") return undefined;
        i += 1;
        return next;
      };
      switch (flag) {
        case "--kind": {
          const value = takeValue();
          if (value === undefined || !/^[a-z][a-z0-9-]{0,20}$/u.test(value)) return error(`--kind needs an agent kind such as claude or codex. ${usage}`);
          agentKind = value;
          break;
        }
        case "--pane": {
          const value = takeValue();
          if (value === undefined || !/^[a-z][a-z0-9]*:p[0-9]+$/iu.test(value)) return error(`--pane needs a pane id such as w1:p2. ${usage}`);
          paneId = value;
          break;
        }
        case "--cwd": {
          const value = takeValue();
          if (value === undefined) return error(`--cwd needs a path. ${usage}`);
          cwd = value;
          break;
        }
        case "--timeout": {
          const value = takeValue();
          const ms = value !== undefined && /^\d{4,6}$/u.test(value) ? Number(value) : Number.NaN;
          if (!Number.isFinite(ms) || ms <= 3000 || ms > 300_000) return error(`--timeout is in milliseconds, more than 3000 and at most 300000. ${usage}`);
          timeoutMs = ms;
          break;
        }
        default:
          return error(`Did not understand "${token}". ${usage}`);
      }
    }
    return {
      kind: "start",
      name: rawName,
      agentKind: agentKind ?? DEFAULT_AGENT_KIND,
      ...(paneId !== undefined ? { paneId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(agentArgs !== undefined ? { agentArgs } : {}),
    };
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
  // followed by whitespace, so pane ids like w6:p1 keep their own colon,
  // and an optional trailing @server is captured along with the selector.
  const targetedPattern = new RegExp(`^([A-Za-z][\\w:-]{0,40}(?:@${SERVER_SOURCE})?):\\s+(\\S[\\s\\S]*)$`, "u");
  const targeted = targetedPattern.exec(args);
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
  "/herdr start <name> --kind <kind> [--pane <id>] [--cwd <path>] [-- <agent args>] — like herdr agent start; opens a pane when --pane is omitted",
  `Targets: ${TARGET_HINT}; a pane id wins over a name, a name over a kind.`,
  "Add @machine to target a saved Herdr machine: w9:p1@buildbox",
  "list/status/read/watch/unwatch/start are commands: to send a prompt that starts with one, use /herdr <target>: <prompt>.",
].join("\n");
