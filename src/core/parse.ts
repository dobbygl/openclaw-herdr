import { messages, type Messages, type TargetSyntaxProblem } from "./i18n.js";

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
 * A bare selector (pane id, terminal id, agent name, tab label or agent kind)
 * starts with a letter or digit (any script, so `revisión` or `7` work) and
 * continues with letters, digits, `_`, `.`, `:`, `-` or `#` (tab labels like
 * `sample#reviewer`). No spaces and no `@`. It may carry
 * a trailing `@<server>` naming a saved Herdr machine, e.g. `w9:p1@buildbox`,
 * `reviewer@buildbox`, `claude@buildbox`. `<server>` is a Herdr machine label
 * or profile id: it must start with an alphanumeric and may continue with
 * alphanumerics, `.`, `_` or `-`.
 */
const SELECTOR_SOURCE = "[\\p{L}\\p{N}][\\p{L}\\p{N}_.:#-]{0,63}";
const SERVER_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const TARGET = new RegExp(`^${SELECTOR_SOURCE}(?:@${SERVER_SOURCE})?$`, "iu");

/** Herdr's `agent.read` (and the herdr_read tool) accept 1-400 lines. */
export const MIN_READ_LINES = 1;
export const MAX_READ_LINES = 400;

/**
 * Thrown by {@link parseTargetRef} for a target that cannot be split into a
 * selector and an optional server. `message` is English (logs, tests); chat
 * words `problem` in the operator's language via `Messages.targetSyntax`.
 */
export class TargetSyntaxError extends Error {
  readonly problem: TargetSyntaxProblem;
  constructor(problem: TargetSyntaxProblem) {
    super(messages("en").targetSyntax(problem));
    this.name = "TargetSyntaxError";
    this.problem = problem;
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
    if (target === "") throw new TargetSyntaxError({ kind: "empty", target });
    return { selector: target };
  }
  const selector = target.slice(0, at);
  const server = target.slice(at + 1);
  if (selector === "") throw new TargetSyntaxError({ kind: "empty_selector", target });
  if (selector.includes("@")) throw new TargetSyntaxError({ kind: "selector_at", target });
  if (server === "" || !new RegExp(`^${SERVER_SOURCE}$`, "u").test(server)) {
    throw new TargetSyntaxError({ kind: "bad_server", target, server });
  }
  return { selector, server };
}

/** The inverse of {@link parseTargetRef}: `selector` alone, or `selector@server`. */
export function formatTargetRef(selector: string, server?: string): string {
  return server ? `${selector}@${server}` : selector;
}

/** Parses `/herdr …`. `m` words the usage errors; the grammar is the same in every language. */
export function parseHerdrCommand(m: Messages, rawArgs: string | undefined): HerdrCommand {
  const hint = m.targetHint;
  const args = (rawArgs ?? "").trim();
  if (args === "" || args === "help" || args === "?") return { kind: "help" };

  const [head = "", ...rest] = args.split(/\s+/u);
  const word = head.toLowerCase();
  const tail = rest.join(" ").trim();

  if (word === "list" || word === "ls") return { kind: "list" };

  if (word === "status" || word === "st") {
    if (tail === "") return { kind: "status" };
    if (TARGET.test(tail)) return { kind: "status", target: tail };
    return error(m.statusNotTarget(tail, hint));
  }

  if (word === "read" || word === "tail") {
    const [target, count, ...extra] = rest;
    if (target === undefined) {
      return error(m.readUsage(MIN_READ_LINES, MAX_READ_LINES, hint));
    }
    if (!TARGET.test(target)) {
      return error(m.readNotTarget(target, MIN_READ_LINES, MAX_READ_LINES, args));
    }
    if (extra.length > 0) {
      return error(m.readExtra(MIN_READ_LINES, MAX_READ_LINES));
    }
    if (count === undefined) return { kind: "read", target };
    const lines = readLineCount(count);
    if (lines === undefined) {
      return error(m.readBadCount(count, MIN_READ_LINES, MAX_READ_LINES));
    }
    return { kind: "read", target, lines };
  }

  if (word === "start") {
    // `/herdr start <name> [kind] [pane id | path]` — positional, phone-friendly.
    // A token shaped like a pane id (w1:p2) picks an existing idle shell pane;
    // a token starting with ~ / or . is the directory of a new pane.
    const usage = m.startUsage;
    const [rawName, ...more] = rest;
    if (rawName === undefined) return error(m.startUsageDefault(usage, DEFAULT_AGENT_KIND));
    const at = rawName.lastIndexOf("@");
    const bareName = at > 0 ? rawName.slice(0, at) : rawName;
    const server = at > 0 ? rawName.slice(at + 1) : undefined;
    if (!AGENT_NAME.test(bareName) || (server !== undefined && !new RegExp(`^${SERVER_SOURCE}$`, "u").test(server))) {
      return error(m.startBadName(rawName));
    }
    let agentKind: string | undefined;
    let paneId: string | undefined;
    let cwd: string | undefined;
    for (const token of more) {
      if (/^[a-z][a-z0-9]*:p[0-9]+$/iu.test(token) && paneId === undefined && cwd === undefined) paneId = token;
      else if ((token.startsWith("/") || token.startsWith("~") || token.startsWith(".")) && cwd === undefined && paneId === undefined) cwd = token;
      else if (/^[a-z][a-z0-9-]{0,20}$/u.test(token) && agentKind === undefined) agentKind = token;
      else return error(m.startBadToken(token, usage));
    }
    return {
      kind: "start",
      name: rawName,
      agentKind: agentKind ?? DEFAULT_AGENT_KIND,
      ...(paneId !== undefined ? { paneId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  if (word === "watch" || word === "unwatch") {
    if (rest.length === 1 && TARGET.test(rest[0] ?? "")) return { kind: word, target: rest[0] as string };
    return error(
      rest.length === 0 ? m.watchUsage(word, hint) : m.watchOneTarget(word, hint),
    );
  }

  // "<target>: <prompt>" — the target ends at the first colon that is
  // followed by whitespace, so pane ids like w6:p1 keep their own colon,
  // and an optional trailing @server is captured along with the selector.
  const targetedPattern = new RegExp(`^(${SELECTOR_SOURCE}(?:@${SERVER_SOURCE})?):\\s+(\\S[\\s\\S]*)$`, "u");
  const targeted = targetedPattern.exec(args);
  if (targeted && TARGET.test(targeted[1] ?? "")) {
    return { kind: "send", target: targeted[1] as string, text: (targeted[2] as string).trim() };
  }
  // A head that names a machine (`x@buildbox: …`) is an explicit target even
  // when it is malformed. Degrading it to "send to the only agent" would type
  // into a local pane what was meant for another machine.
  const explicitHead = /^(\S+?):\s+\S/u.exec(args)?.[1];
  if (explicitHead !== undefined && explicitHead.includes("@")) {
    return error(m.invalidExplicitTarget(explicitHead, hint));
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

/** `/herdr help` in the operator's language; the command lines themselves are identical in every language. */
export function helpText(m: Messages): string {
  return m.help(MIN_READ_LINES, MAX_READ_LINES, m.targetHint).join("\n");
}
