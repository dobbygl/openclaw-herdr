/**
 * Remote transport: Herdr's own socket protocol, carried over `ssh` stdio.
 *
 * ## Why this shape
 *
 * Herdr's socket API has no machine routing, and `herdr --machine <label> …`,
 * its own remote CLI, costs 6-12 s per call (SSH plus remote bridge discovery)
 * and exposes no `events.subscribe` - only a blocking `agent wait`. Watching a
 * remote agent needs the streaming subscription, so instead of wrapping that
 * CLI we speak the exact same newline-delimited JSON to the remote Unix socket
 * and reuse every line of `HerdrClient`, `LineDecoder` and the watcher.
 *
 * The remote end is one process that copies bytes between its stdio and the
 * socket: `socat - UNIX-CONNECT:<path>`, or a pure-`python3` bridge as a
 * fallback where `socat` is not installed. Nothing is installed remotely, no
 * port is opened, no tunnel or local socket file is created.
 *
 * ## Measured on this host (2026-09-20, remote Herdr 0.9.1, protocol 22)
 *
 *  - `ping` over `ssh … socat`: ~0.6 s with a warm ControlMaster, ~2 s cold.
 *  - `herdr --machine …` for the same answer: 6-12 s.
 *
 * So multiplexing is what makes this usable: `ControlMaster=auto` plus
 * `ControlPersist=120` keep one authenticated master alive, and each request
 * (Herdr closes the connection after every response) is a cheap session on it.
 * The caller owns the `ControlPath` - it should live in the plugin state dir,
 * mode 0700.
 *
 * ## Security notes
 *
 *  - ssh is spawned with an argv array, never a shell string. Caller-controlled
 *    values (`target`, `controlPath`, the remote path) are separate argv items.
 *  - The *remote* side is a shell, because ssh joins the command arguments and
 *    hands them to the login shell. Everything that ends up in that command -
 *    the socket path, a session name, the remote binary name - is therefore
 *    checked against a strict whitelist first (`assertSafeRemotePath` /
 *    `assertSafeRemoteWord`). A socket path is also required to be absolute.
 *  - `target` must not start with `-`, which ssh would read as an option.
 *  - The remote socket is mode 0600 and owned by the remote user, so the SSH
 *    user must be that user; `herdr machine add` requires the same.
 *  - `BatchMode=yes` and `StrictHostKeyChecking=yes` are fixed: an unattended
 *    plugin must never wait on a password prompt or accept a new host key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { HerdrTransportError, causeMessage } from "./client.js";
import type { ConnectionFactory, DuplexLike } from "./connection.js";

/** Which remote helper copies bytes between ssh stdio and the Unix socket. */
export type RemoteTool = "socat" | "python";

/** Everything ssh itself is told, beyond the target and the remote command. */
export const SSH_FIXED_OPTIONS: readonly string[] = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "ConnectTimeout=10",
  "ServerAliveInterval=15",
  "ServerAliveCountMax=4",
  "ControlMaster=auto",
  "ControlPersist=120",
];

/** At most this much stderr is kept per connection for failure classification. */
const MAX_STDERR_CHARS = 4096;

export interface SshConnectionOptions {
  /** SSH target: `alice@host` or a host from the user's ssh config. */
  target: string;
  /** Absolute path of the Herdr socket on the remote host. */
  socketPath: string;
  /** Defaults to `ssh` from PATH. */
  sshBin?: string;
  /** ControlMaster socket. Without it ssh cannot multiplex and every call is cold. */
  controlPath?: string;
  /** Defaults to `socat`. */
  remoteTool?: RemoteTool;
  /**
   * Local guard for an `ssh` that neither speaks nor exits. Default `0` (off),
   * because `HerdrClient` already bounds every connection (`requestTimeoutMs`,
   * `subscribeAckTimeoutMs`) and an unbounded remote `agent.wait` legitimately
   * stays silent for hours - a guard keyed on "no output yet" would kill it.
   * Set it only where the answer is known to be prompt, e.g. a `ping` probe.
   */
  connectTimeoutMs?: number;
}

/**
 * Checks a value that will be interpolated into the remote shell command.
 * A whitelist, not a blacklist: anything outside `[A-Za-z0-9._/+@:-]` is
 * refused, so no quoting is needed downstream.
 */
export function isSafeRemotePath(value: string): boolean {
  return value.startsWith("/") && value.length <= 4096 && /^[A-Za-z0-9._/+@:-]+$/u.test(value);
}

export function assertSafeRemotePath(value: string, what = "remote socket path"): string {
  if (!value.startsWith("/")) throw new HerdrTransportError(`${what} must be absolute: ${JSON.stringify(value)}`);
  if (!isSafeRemotePath(value)) {
    throw new HerdrTransportError(
      `${what} contains characters this transport refuses to pass to a remote shell: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Same rule for a bare word (a session name, a remote binary name). */
export function assertSafeRemoteWord(value: string, what = "value"): string {
  if (value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._/+@:-]+$/u.test(value)) {
    throw new HerdrTransportError(`${what} is not a safe remote argument: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A target starting with `-` would be parsed by ssh as an option, not a host. */
export function assertSshTarget(value: string): string {
  if (value.length === 0 || value.length > 256 || /^-/u.test(value) || /[^\w.@%:[\]-]/u.test(value)) {
    throw new HerdrTransportError(`SSH target is not usable: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertControlPath(value: string): string {
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new HerdrTransportError(`ControlPath is not usable: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The python fallback: connect, pump stdin into the socket on a thread, copy
 * everything the socket says to stdout. Written without a single quote so the
 * whole program can be passed as one single-quoted remote shell word.
 */
function pythonBridge(socketPath: string): string {
  return [
    "import socket,sys,threading",
    "s=socket.socket(socket.AF_UNIX)",
    `s.connect("${socketPath}")`,
    "def up():",
    " b=sys.stdin.buffer",
    " while 1:",
    "  d=b.read1(65536)",
    "  if not d: break",
    "  s.sendall(d)",
    " try: s.shutdown(socket.SHUT_WR)",
    " except OSError: pass",
    "threading.Thread(target=up,daemon=True).start()",
    "o=sys.stdout.buffer",
    "while 1:",
    " d=s.recv(65536)",
    " if not d: break",
    " o.write(d)",
    " o.flush()",
  ].join("\n");
}

/** The single command string ssh hands to the remote login shell. */
export function buildRemoteCommand(tool: RemoteTool, socketPath: string): string {
  const safe = assertSafeRemotePath(socketPath);
  if (tool === "socat") return `socat - UNIX-CONNECT:${safe}`;
  return `python3 -c '${pythonBridge(safe)}'`;
}

/** The fixed option block, plus `ControlPath` when the caller supplied one. */
export function sshOptionArgs(controlPath?: string): string[] {
  const args: string[] = [];
  for (const option of SSH_FIXED_OPTIONS) args.push("-o", option);
  if (controlPath !== undefined) args.push("-o", `ControlPath=${assertControlPath(controlPath)}`);
  args.push("-T");
  return args;
}

/** Full argv for `ssh`, program name excluded. */
export function buildSshArgv(options: { target: string; remoteCommand: string; controlPath?: string }): string[] {
  const target = assertSshTarget(options.target);
  return [
    ...sshOptionArgs(options.controlPath),
    target,
    options.remoteCommand,
  ];
}

const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/command not found|:\s*not found/iu, "the remote helper (socat or python3) is not installed"],
  [/host key verification failed|remote host identification has changed/iu, "remote host key verification failed"],
  [/permission denied \(|publickey|password|keyboard-interactive|authentication/iu, "ssh authentication failed"],
  [/filenotfounderror|no such file or directory/iu, "the remote Herdr socket does not exist"],
  [/connectionrefusederror|af=1|unix-connect/iu, "the remote Herdr socket refused the connection"],
  [/connection refused/iu, "ssh could not connect (connection refused)"],
  [/could not resolve|name or service not known|nodename nor servname/iu, "the remote host could not be resolved"],
  [/permissionerror|permission denied/iu, "permission denied on the remote Herdr socket"],
  [/timed out/iu, "ssh timed out connecting"],
  [/closed by remote host|connection reset|broken pipe/iu, "the ssh connection dropped"],
];

/**
 * Turns an ssh exit into one short, operator-readable reason. Order matters:
 * socat and python report a missing or refused *socket* with wording that also
 * appears in ssh's own network errors, so the remote-side markers are matched
 * first.
 */
export function classifySshFailure(outcome: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): string {
  const stderr = outcome.stderr.trim();
  for (const [pattern, reason] of FAILURE_PATTERNS) {
    if (pattern.test(stderr)) return reason;
  }
  if (outcome.signal) return `ssh was killed by ${outcome.signal}`;
  const detail = stderr ? `: ${firstLine(stderr)}` : "";
  return `ssh exited with code ${outcome.code ?? "unknown"}${detail}`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * One ssh child presented as the duplex `HerdrClient` consumes.
 *
 * Contract details that matter to the client:
 *  - `error` is always emitted *before* `close` on a failed exit, because the
 *    client settles first-wins: without it every remote failure would surface
 *    as the generic "closed the connection before answering".
 *  - the child's `close` (not `exit`) drives our `close`, so a final response
 *    line can never lose the race against it.
 *  - a deliberate `destroy()` is silent: killing the child after a successful
 *    response must not look like a transport error.
 */
export class SshStdioConnection extends EventEmitter implements DuplexLike {
  readonly #child: ChildProcess;
  readonly #target: string;
  #stderr = "";
  #destroyed = false;
  #closeEmitted = false;
  #connectTimer: NodeJS.Timeout | undefined;

  constructor(options: SshConnectionOptions) {
    super();
    const sshBin = options.sshBin ?? "ssh";
    const remoteCommand = buildRemoteCommand(options.remoteTool ?? "socat", options.socketPath);
    const argv = buildSshArgv({
      target: options.target,
      remoteCommand,
      ...(options.controlPath !== undefined ? { controlPath: options.controlPath } : {}),
    });
    this.#target = options.target;
    const child = spawn(sshBin, argv, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.#clearConnectTimer();
      this.emit("data", chunk);
    });
    child.stdout?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (this.#stderr.length < MAX_STDERR_CHARS) {
        this.#stderr = (this.#stderr + chunk).slice(0, MAX_STDERR_CHARS);
      }
    });
    child.stderr?.on("error", () => {});
    // ssh dying mid-write turns our request into an EPIPE on stdin; the child's
    // `close` carries the real reason, so the write error is not the story.
    child.stdin?.on("error", () => {});

    child.on("error", (cause) => {
      this.#failAndClose(`ssh could not be started: ${causeMessage(cause)}`, cause);
    });
    child.on("close", (code, signal) => {
      this.#clearConnectTimer();
      if (this.#destroyed || (code === 0 && !signal)) {
        this.#emitClose();
        return;
      }
      this.#failAndClose(
        `ssh to ${this.#target}: ${classifySshFailure({ code, signal, stderr: this.#stderr })}`,
      );
    });

    const connectTimeoutMs = options.connectTimeoutMs ?? 0;
    if (connectTimeoutMs > 0 && Number.isFinite(connectTimeoutMs)) {
      this.#connectTimer = setTimeout(() => {
        this.#connectTimer = undefined;
        this.#failAndClose(`ssh to ${this.#target} said nothing within ${connectTimeoutMs}ms`);
        this.destroy();
      }, connectTimeoutMs);
      this.#connectTimer.unref();
    }
  }

  /** The ssh process id, or `undefined` once it is gone. Handy for diagnostics. */
  get pid(): number | undefined {
    return this.#child.pid;
  }

  write(data: string): boolean {
    const stdin = this.#child.stdin;
    if (this.#destroyed || !stdin || stdin.destroyed) return false;
    return stdin.write(data);
  }

  setEncoding(encoding: "utf8"): this {
    this.#child.stdout?.setEncoding(encoding);
    return this;
  }

  /** Idempotent, and it takes the ssh child with it. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearConnectTimer();
    const child = this.#child;
    try {
      child.stdin?.end();
    } catch {
      // already gone
    }
    const dead = child.exitCode !== null || child.signalCode !== null;
    if (dead) {
      // No further `close` is coming; keep the contract anyway.
      queueMicrotask(() => this.#emitClose());
      return;
    }
    child.kill("SIGKILL");
  }

  #failAndClose(message: string, cause?: unknown): void {
    if (this.#closeEmitted) return;
    const error =
      cause === undefined
        ? new HerdrTransportError(message)
        : new HerdrTransportError(message, { cause });
    this.emit("error", error);
    this.#emitClose();
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.emit("close");
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
  }
}

/**
 * A `ConnectionFactory` that spawns one ssh child per connection. Validation
 * happens here, once, so a misconfigured machine fails at setup rather than on
 * every request.
 */
export function createSshConnectionFactory(options: SshConnectionOptions): ConnectionFactory {
  assertSshTarget(options.target);
  assertSafeRemotePath(options.socketPath);
  if (options.controlPath !== undefined) assertControlPath(options.controlPath);
  buildRemoteCommand(options.remoteTool ?? "socat", options.socketPath);
  return () => new SshStdioConnection(options);
}
