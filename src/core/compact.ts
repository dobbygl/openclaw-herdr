/**
 * Cosmetic compaction of pane output for chat clients (Telegram wraps code
 * blocks at ~60 columns on a phone, so a 120-column TUI frame turns into
 * noise). This only changes how text LOOKS; it never decides agent state.
 */
const BOX_LINE = /^[\s─━═┄┈╌]+$/u;
const FOOTER_HINT = /bypass permissions|shift\+tab|for shortcuts|← for agents|accept edits on|manual mode on|plan mode on/iu;
const EMPTY_PROMPT = /^\s*[❯>›]\s*$/u;
const USER_HOST_PATH = /^\s*[\w.-]+@[\w.-]+\s+(?:~|\/)\S*\s*$/u;
const TOKEN_HINT = /^\s*new task\? \/clear to save [\d.,]+k? tokens\s*$/iu;

export interface CompactOptions {
  maxLines?: number;
  /** Lines with more leading spaces than this are treated as right-aligned hints and dedented. */
  maxIndent?: number;
}

export function compactPaneText(raw: string, options: CompactOptions = {}): string {
  const maxLines = options.maxLines ?? 20;
  const maxIndent = options.maxIndent ?? 8;
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
  return out.slice(-maxLines).join("\n");
}
