/**
 * The transport seam of the Herdr client.
 *
 * `HerdrClient` only ever needs a bidirectional, newline-delimited byte stream:
 * write one JSON request, read JSON lines back, notice errors and closure. That
 * is all `DuplexLike` describes, so both a local `net.Socket` and the stdio of
 * an `ssh` child process fit it without the client knowing which it holds.
 *
 * Deliberately not part of the contract:
 *  - a `connect` event. A child process has none, so the client writes its
 *    request immediately; `net.Socket` buffers writes until it is connected.
 *  - back-pressure. A Herdr request is a single short line.
 */
import net from "node:net";

/** Minimal duplex surface the client consumes. `net.Socket` satisfies it as-is. */
export interface DuplexLike {
  write(data: string): unknown;
  setEncoding(encoding: "utf8"): unknown;
  destroy(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/**
 * Opens one connection. Called once per request and once per subscription, so
 * it must be cheap to call repeatedly and must never hand out a shared stream.
 * Throwing synchronously is allowed: the client turns that into a transport
 * error on both paths.
 */
export type ConnectionFactory = () => DuplexLike;

/** The local transport: a fresh Unix-domain socket per connection. */
export function createUnixSocketFactory(socketPath: string): ConnectionFactory {
  return () => net.createConnection(socketPath);
}
