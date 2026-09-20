/**
 * The machine catalog: which remote Herdr servers exist, and where their
 * sockets are.
 *
 * Machines are *discovered, not configured*. Herdr already stores them
 * (`herdr machine add alice@host --label buildbox`), so this module reads
 * `herdr machine list --json` instead of duplicating the list in plugin
 * config, and resolves each remote socket path with
 * `ssh <target> herdr status server`.
 *
 * Both calls spawn a process, so both are cached with a TTL: the list is cheap
 * and local (30 s), a socket path costs a round trip and effectively never
 * changes while a server is up (10 min).
 */
import { spawn } from "node:child_process";
import { HerdrTransportError, causeMessage, isRecord } from "./client.js";
import { assertSafeRemotePath, assertSafeRemoteWord, assertSshTarget, buildSshArgv } from "./ssh-stdio.js";

/** One enabled entry of `herdr machine list --json`. Unknown fields are dropped. */
export interface Machine {
  id: string;
  label: string;
  /** SSH target, as Herdr stored it. */
  target: string;
  /** Herdr session name on that host, when it is not the default one. */
  session?: string;
  enabled: boolean;
}

export const DEFAULT_MACHINE_LIST_TTL_MS = 30_000;
export const DEFAULT_SOCKET_PATH_TTL_MS = 600_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export interface ListMachinesOptions {
  /** Defaults to `herdr` from PATH. */
  herdrBin?: string;
  timeoutMs?: number;
}

export interface ResolveSocketPathOptions {
  target: string;
  /** Defaults to `ssh` from PATH. */
  sshBin?: string;
  /** Herdr session on the remote host; omitted means Herdr's default session. */
  session?: string;
  /** ControlMaster socket, shared with the stdio transport for a warm session. */
  controlPath?: string;
  /** Remote `herdr` binary; defaults to `herdr` on the remote PATH. */
  remoteHerdrBin?: string;
  timeoutMs?: number;
}

/**
 * Validates one row. A machine we could not reach later - no id, label or
 * usable SSH target - is dropped here rather than downstream, the same rule
 * `normalizeAgentInfo` follows for panes. `enabled` defaults to true so a
 * future Herdr that stops emitting it does not empty the catalog.
 */
export function normalizeMachine(value: unknown): Machine | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const target = typeof value.target === "string" ? value.target.trim() : "";
  if (!id || !label || !target) return undefined;
  try {
    assertSshTarget(target);
  } catch {
    return undefined;
  }
  const session = typeof value.session === "string" && value.session.trim() ? value.session.trim() : undefined;
  return {
    id,
    label,
    target,
    ...(session !== undefined ? { session } : {}),
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
  };
}

/** Enabled machines Herdr knows about, in the order it lists them. */
export async function listMachines(options: ListMachinesOptions = {}): Promise<Machine[]> {
  const bin = options.herdrBin ?? "herdr";
  const outcome = await runCommand(bin, ["machine", "list", "--json"], options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  if (outcome.timedOut) {
    throw new HerdrTransportError(`${bin} machine list --json timed out after ${outcome.timeoutMs}ms`);
  }
  if (outcome.code !== 0) {
    throw new HerdrTransportError(
      `${bin} machine list --json failed (exit ${outcome.code ?? outcome.signal ?? "unknown"})${detail(outcome.stderr)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch (cause) {
    throw new HerdrTransportError(`${bin} machine list --json did not print JSON: ${causeMessage(cause)}`, { cause });
  }
  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.machines) ? parsed.machines : undefined;
  if (!rows) throw new HerdrTransportError(`${bin} machine list --json did not print an array of machines`);
  const machines: Machine[] = [];
  for (const row of rows) {
    const machine = normalizeMachine(row);
    if (machine?.enabled) machines.push(machine);
  }
  return machines;
}

/**
 * Asks the remote Herdr where its socket is. The answer is interpolated into a
 * remote shell command later, so it is validated with the same whitelist as a
 * caller-supplied path - a parsed value is not a trusted value.
 */
export async function resolveRemoteSocketPath(options: ResolveSocketPathOptions): Promise<string> {
  const sshBin = options.sshBin ?? "ssh";
  const remoteBin = assertSafeRemoteWord(options.remoteHerdrBin ?? "herdr", "remote herdr binary");
  const session = options.session !== undefined ? assertSafeRemoteWord(options.session, "session name") : undefined;
  const remoteCommand = session !== undefined
    ? `${remoteBin} --session ${session} status server`
    : `${remoteBin} status server`;
  const argv = buildSshArgv({
    target: options.target,
    remoteCommand,
    ...(options.controlPath !== undefined ? { controlPath: options.controlPath } : {}),
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const outcome = await runCommand(sshBin, argv, timeoutMs);
  if (outcome.timedOut) {
    throw new HerdrTransportError(`${remoteCommand} on ${options.target} timed out after ${timeoutMs}ms`);
  }
  if (outcome.code !== 0) {
    throw new HerdrTransportError(
      `${remoteCommand} on ${options.target} failed (exit ${outcome.code ?? outcome.signal ?? "unknown"})${detail(outcome.stderr)}`,
    );
  }
  const socketPath = parseSocketLine(outcome.stdout);
  if (socketPath === undefined) {
    throw new HerdrTransportError(`${remoteCommand} on ${options.target} printed no "socket:" line`);
  }
  return assertSafeRemotePath(socketPath, `socket path reported by ${options.target}`);
}

/** First `socket: <path>` line of `herdr status server`. */
export function parseSocketLine(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = /^\s*socket\s*:\s*(\S+)\s*$/iu.exec(line);
    const value = match?.[1];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Cheap TTL cache with an injectable clock, so expiry is testable. */
export class TtlCache<T> {
  readonly ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.set(key, { value, expiresAt: this.#now() + this.ttlMs });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

export interface MachineCatalogOptions {
  herdrBin?: string;
  sshBin?: string;
  controlPath?: string;
  timeoutMs?: number;
  listTtlMs?: number;
  socketPathTtlMs?: number;
  now?: () => number;
}

/**
 * What the runtime holds: the enabled machines and their socket paths, each
 * behind a TTL cache and a single-flight guard, so a burst of watches that all
 * wake at startup produces one `herdr machine list` and one `ssh` per machine
 * rather than one per watch.
 */
export class MachineCatalog {
  readonly #options: MachineCatalogOptions;
  readonly #machines: TtlCache<Machine[]>;
  readonly #socketPaths: TtlCache<string>;
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(options: MachineCatalogOptions = {}) {
    this.#options = options;
    const now = options.now;
    this.#machines = new TtlCache<Machine[]>({
      ttlMs: options.listTtlMs ?? DEFAULT_MACHINE_LIST_TTL_MS,
      ...(now ? { now } : {}),
    });
    this.#socketPaths = new TtlCache<string>({
      ttlMs: options.socketPathTtlMs ?? DEFAULT_SOCKET_PATH_TTL_MS,
      ...(now ? { now } : {}),
    });
  }

  async machines(options: { refresh?: boolean } = {}): Promise<Machine[]> {
    if (options.refresh) this.#machines.delete("all");
    const cached = this.#machines.get("all");
    if (cached) return cached;
    return this.#once("machines", async () => {
      const machines = await listMachines({
        ...(this.#options.herdrBin !== undefined ? { herdrBin: this.#options.herdrBin } : {}),
        ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      });
      this.#machines.set("all", machines);
      return machines;
    });
  }

  /** Resolves (and caches) the Herdr socket path on one machine. */
  async socketPath(machine: { target: string; session?: string }, options: { refresh?: boolean } = {}): Promise<string> {
    const key = `${machine.target}\u0000${machine.session ?? ""}`;
    if (options.refresh) this.#socketPaths.delete(key);
    const cached = this.#socketPaths.get(key);
    if (cached !== undefined) return cached;
    return this.#once(`socket:${key}`, async () => {
      const socketPath = await resolveRemoteSocketPath({
        target: machine.target,
        ...(machine.session !== undefined ? { session: machine.session } : {}),
        ...(this.#options.sshBin !== undefined ? { sshBin: this.#options.sshBin } : {}),
        ...(this.#options.controlPath !== undefined ? { controlPath: this.#options.controlPath } : {}),
        ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      });
      this.#socketPaths.set(key, socketPath);
      return socketPath;
    });
  }

  /** Forget everything; call after an ssh failure that may mean "server moved". */
  invalidate(): void {
    this.#machines.clear();
    this.#socketPaths.clear();
  }

  async #once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.#inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = run().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, promise);
    return promise;
  }
}

interface CommandOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
}

/** `spawn` with an argv array (never a shell), a hard timeout and captured output. */
function runCommand(bin: string, argv: string[], timeoutMs: number): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      reject(new HerdrTransportError(`${bin} could not be started: ${causeMessage(cause)}`, { cause }));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HerdrTransportError(`${bin} could not be started: ${causeMessage(cause)}`, { cause }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, timeoutMs });
    });
  });
}

function detail(stderr: string): string {
  const line = stderr.trim().split("\n", 1)[0] ?? "";
  if (!line) return "";
  return `: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`;
}

