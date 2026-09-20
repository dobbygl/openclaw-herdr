/**
 * Newline-delimited JSON framing. Pure and synchronous so it is trivial to
 * test; the socket layer feeds it chunks and drains complete lines.
 */
export class LineDecoder {
  #buffer = "";

  /** Feed a chunk and return every complete line it produced (without the newline). */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/u, "");
      if (line.length > 0) lines.push(line);
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
    }
    return lines;
  }

  /** Anything left without a trailing newline. */
  pending(): string {
    return this.#buffer;
  }
}

export function encodeRequest(id: string, method: string, params: unknown): string {
  return JSON.stringify({ id, method, params: params ?? {} }) + "\n";
}
