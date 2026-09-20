/**
 * Cosmetic compaction of pane output for chat clients (Telegram wraps code
 * blocks at ~60 columns on a phone, so a 120-column TUI frame turns into
 * noise). This only changes how text LOOKS; it never decides agent state.
 *
 * Three hard limits keep a pane block chat-sized no matter what the agent
 * printed:
 *  - `maxLines` keeps only the last N lines (silently, as before);
 *  - `maxChars` is a character budget for the whole block: lines are dropped
 *    from the top until it fits and a `… (N earlier lines omitted)` first line
 *    says so;
 *  - `maxLineChars` truncates a single very long line with `…`.
 *
 * Runs of three or more backticks are replaced with the same number of
 * U+02CB MODIFIER LETTER GRAVE ACCENT (`ˋˋˋ`), so a stray fence in agent
 * output cannot close the Markdown code block the caller wraps this in.
 */
const BOX_LINE = /^[\s─━═┄┈╌]+$/u;
const FOOTER_HINT = /bypass permissions|shift\+tab|for shortcuts|← for agents|accept edits on|manual mode on|plan mode on/iu;
const EMPTY_PROMPT = /^\s*[❯>›]\s*$/u;
const USER_HOST_PATH = /^\s*[\w.-]+@[\w.-]+\s+(?:~|\/)\S*\s*$/u;
const TOKEN_HINT = /^\s*new task\? \/clear to save [\d.,]+k? tokens\s*$/iu;
const FENCE = /`{3,}/gu;
/** Visual stand-in for a backtick that cannot close a Markdown fence. */
const SAFE_BACKTICK = "ˋ";

export const DEFAULT_MAX_LINES = 20;
export const DEFAULT_MAX_CHARS = 3000;
export const DEFAULT_MAX_LINE_CHARS = 400;

export interface CompactOptions {
  maxLines?: number;
  /** Lines with more leading spaces than this are treated as right-aligned hints and dedented. */
  maxIndent?: number;
  /** Character budget for the whole block; older lines are dropped and announced. Default 3000. */
  maxChars?: number;
  /** Longer single lines are truncated with `…`. Default 400. */
  maxLineChars?: number;
}

export function compactPaneText(raw: string, options: CompactOptions = {}): string {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxIndent = options.maxIndent ?? 8;
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxLineChars = Math.max(1, options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
  const lines = raw.replace(/\r/gu, "").split("\n").map((line) => line.replace(/\s+$/u, ""));

  // Drop Claude/Codex footer chrome only when it sits at the very bottom.
  while (lines.length > 0) {
    const last = lines.at(-1) ?? "";
    if (
      last === "" ||
      USER_HOST_PATH.test(last) ||
      FOOTER_HINT.test(last) ||
      BOX_LINE.test(last) ||
      TOKEN_HINT.test(last) ||
      EMPTY_PROMPT.test(last)
    ) {
      lines.pop();
      continue;
    }
    break;
  }

  const out: string[] = [];
  for (const original of lines) {
    let line = original;
    if (BOX_LINE.test(line) && line.trim() !== "") line = "───";
    const indent = line.length - line.trimStart().length;
    if (indent > maxIndent) line = "  " + line.trimStart();
    const prev = out.at(-1);
    if (line === "" && (prev === "" || prev === "───")) continue;
    if (line === "───") {
      while (out.at(-1) === "") out.pop();
      if (out.at(-1) === "───") continue;
    }
    out.push(line);
  }
  while (out.length > 0 && (out[0] === "" || out[0] === "───")) out.shift();
  const kept = out.slice(-maxLines).map((line) => clampLine(line, maxLineChars));
  return applyCharBudget(kept, maxChars);
}

/** Neutralize Markdown fences, then cut an over-long line down to size. */
function clampLine(line: string, maxLineChars: number): string {
  const safe = line.replace(FENCE, (run) => SAFE_BACKTICK.repeat(run.length));
  return safe.length > maxLineChars ? safe.slice(0, maxLineChars - 1) + "…" : safe;
}

/** Keep the newest lines that fit in `maxChars`; say how many older ones were dropped. */
function applyCharBudget(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && total + cost > maxChars) break;
    kept.unshift(line);
    total += cost;
  }
  const omitted = lines.length - kept.length;
  if (omitted === 0) return kept.join("\n");
  return [`… (${omitted} earlier line${omitted === 1 ? "" : "s"} omitted)`, ...kept].join("\n");
}
