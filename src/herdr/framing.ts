/**
 * Newline-delimited JSON framing. Pure and synchronous so it is trivial to
 * test; the socket layer feeds it chunks and drains complete lines.
 */

/** Default ceiling for a single JSON line. Herdr never sends anything close. */
export const DEFAULT_MAX_LINE_LENGTH = 4 * 1024 * 1024;

/**
 * Thrown when a peer sends more than `limit` characters for one line. The
 * decoder drops its buffer first, so the connection can only be failed, never
 * silently continued: the framing is already out of sync at that point.
 */
export class LineTooLongError extends Error {
  readonly limit: number;
  readonly length: number;
  constructor(limit: number, length: number) {
    super(`line of ${length} characters exceeds the ${limit} character limit`);
    this.name = "LineTooLongError";
    this.limit = limit;
    this.length = length;
  }
}

export interface LineDecoderOptions {
  /**
   * Maximum characters accepted for one line, buffered remainder included.
   * A misbehaving peer that never sends a newline therefore cannot grow this
   * process's memory without bound.
   */
  maxLineLength?: number;
}

export class LineDecoder {
  #buffer = "";
  readonly maxLineLength: number;

  constructor(options: LineDecoderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Feed a chunk and return every complete line it produced (without the
   * newline). Throws `LineTooLongError` when a line or the pending remainder
   * grows past `maxLineLength`; the buffer is reset before throwing, and lines
   * already decoded from the same chunk are dropped with it.
   */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > this.maxLineLength) throw this.#overflow(line.length);
      if (line.length > 0) lines.push(line);
      index = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > this.maxLineLength) throw this.#overflow(this.#buffer.length);
    return lines;
  }

  /** Anything left without a trailing newline. */
  pending(): string {
    return this.#buffer;
  }

  /** Drop the buffered remainder. */
  reset(): void {
    this.#buffer = "";
  }

  #overflow(length: number): LineTooLongError {
    this.reset();
    return new LineTooLongError(this.maxLineLength, length);
  }
}

export function encodeRequest(id: string, method: string, params: unknown): string {
  return JSON.stringify({ id, method, params: params ?? {} }) + "\n";
}
