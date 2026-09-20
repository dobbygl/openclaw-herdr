/**
 * Which Herdr servers this plugin can talk to, and one client per server.
 *
 * There is always `local`: the Unix socket on this host. Everything else is
 * *discovered, not configured* — `herdr machine list --json` already holds the
 * machines the operator added with `herdr machine add alice@host --label
 * buildbox`, so the registry reads that catalog (see `herdr/machines.ts`) and
 * builds one {@link HerdrClient} per enabled machine, lazily, on top of the ssh
 * stdio transport (`herdr/ssh-stdio.ts`).
 *
 * Three rules shape the API:
 *
 *  - **Identity vs display.** A watch persists the machine's profile *id*
 *    (stable), messages show its *label* (what the operator typed). `describe`
 *    and `suffix` are synchronous, because notifications are formatted inside
 *    the watcher and must never block or throw on a catalog lookup.
 *  - **Lazy and cached.** Resolving a remote socket path costs an ssh round
 *    trip, so it happens once per client: the cached promise is both the cache
 *    and the single-flight guard. {@link ServerRegistry.clientFor} is the
 *    synchronous view of that cache for the watcher, which cannot await.
 *  - **Health is explicit.** A machine that fails `ping` (or whose subscription
 *    dies) is marked `down` with a short reason and its client is dropped, so
 *    the next attempt re-resolves the socket path. Nothing is ever settled or
 *    guessed on behalf of a server that did not answer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { HerdrClient, HerdrTransportError } from "../herdr/client.js";
import { MachineCatalog, resolveRemoteSocketPath, type Machine } from "../herdr/machines.js";
import { createSshConnectionFactory } from "../herdr/ssh-stdio.js";

/** The host this plugin runs on: the default server, and the only local one. */
export const LOCAL_SERVER_ID = "local";

/** What display code needs about a server. `label` is what the operator sees. */
export interface ServerDescription {
  id: string;
  label: string;
  isLocal: boolean;
}

/** Outcome of the last `ping` (or of a reported failure). */
export interface ServerHealth {
  ok: boolean;
  /** Short, operator-readable reason when `ok` is false. */
  reason?: string;
}

export type ResolveServerResult =
  | { ok: true; server: ServerDescription }
  | { ok: false; message: string };

export interface ServerRegistryLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Only the catalog member the registry uses, so tests can pass a stub. */
export interface MachineSource {
  machines(options?: { refresh?: boolean }): Promise<Machine[]>;
}

export interface ServerRegistryOptions {
  /** Local Herdr socket; defaults to `HerdrClient`'s own default. */
  socketPath?: string;
  /** Transport budget for a local request. */
  requestTimeoutMs?: number;
  /** When false no machine is discovered and only `local` exists. */
  remoteEnabled?: boolean;
  /** Machine labels or ids allowed to receive prompts. */
  allowSend?: readonly string[];
  /** `herdr` executable used for `machine list --json`. */
  herdrBin?: string;
  /** `ssh` executable used by the remote transport. */
  sshBin?: string;
  /** Plugin state dir; the ControlMaster sockets live in `<stateDir>/ssh`. */
  stateDir?: string;
  /** Pre-built local client (tests, and the runtime's own). */
  localClient?: HerdrClient;
  /** Machine catalog; defaults to a real {@link MachineCatalog}. */
  catalog?: MachineSource;
  logger?: ServerRegistryLogger;
  /**
   * Transport budget for one remote request. Larger than the local one on
   * purpose: a cold ControlMaster costs ~2 s before Herdr sees the line.
   */
  remoteRequestTimeoutMs?: number;
  /** How long a remote subscription may take to be acknowledged. */
  remoteSubscribeAckTimeoutMs?: number;
  /** Budget for one health probe. */
  pingTimeoutMs?: number;
  /** How long a health result is reused before probing again. */
  healthTtlMs?: number;
  now?: () => number;
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 15_000;
/** The transport author's advice: ssh plus a remote bridge needs the room. */
export const DEFAULT_REMOTE_SUBSCRIBE_ACK_TIMEOUT_MS = 15_000;
export const DEFAULT_PING_TIMEOUT_MS = 10_000;
export const DEFAULT_HEALTH_TTL_MS = 5_000;

interface ClientEntry {
  promise: Promise<HerdrClient>;
  /** Set once `promise` resolved, which is what makes `clientFor` synchronous. */
  client?: HerdrClient;
}

export class ServerRegistry {
  readonly #local: HerdrClient;
  readonly #options: ServerRegistryOptions;
  readonly #logger: ServerRegistryLogger;
  readonly #catalog: MachineSource | undefined;
  readonly #clients = new Map<string, ClientEntry>();
  readonly #health = new Map<string, { health: ServerHealth; at: number }>();
  /** Servers with a background probe in flight; see `reportFailure`. */
  readonly #probing = new Set<string>();
  #machinesById = new Map<string, Machine>();
  #catalogError: string | undefined;

  constructor(options: ServerRegistryOptions = {}) {
    this.#options = options;
    this.#logger = options.logger ?? {};
    const local =
      options.localClient ??
      new HerdrClient({
        ...(options.socketPath ? { socketPath: options.socketPath } : {}),
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      });
    this.#local = local;
    this.#clients.set(LOCAL_SERVER_ID, { promise: Promise.resolve(local), client: local });
    if (options.remoteEnabled === false) {
      this.#catalog = undefined;
    } else {
      this.#catalog =
        options.catalog ??
        new MachineCatalog({
          ...(options.herdrBin !== undefined ? { herdrBin: options.herdrBin } : {}),
          ...(options.sshBin !== undefined ? { sshBin: options.sshBin } : {}),
        });
    }
  }

  get localClient(): HerdrClient {
    return this.#local;
  }

  /** True when remote machines are discovered at all. */
  get remoteEnabled(): boolean {
    return this.#catalog !== undefined;
  }

  /** Creates `<stateDir>/ssh` (mode 0700) for the ControlMaster sockets. */
  async prepare(): Promise<void> {
    const dir = this.#controlDir();
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.#logger.warn?.(`herdr: could not create ${dir} for ssh multiplexing: ${message(error)}`);
    }
  }

  /** `local` first, then every enabled machine in the order Herdr lists them. */
  async servers(options: { refresh?: boolean } = {}): Promise<ServerDescription[]> {
    const machines = await this.#machines(options);
    return [
      { id: LOCAL_SERVER_ID, label: LOCAL_SERVER_ID, isLocal: true },
      ...machines.map((machine) => ({ id: machine.id, label: machine.label, isLocal: false })),
    ];
  }

  /**
   * Turns a `@server` suffix into one server. Matching is exact: a machine
   * label first (labels are unique and case-sensitive in Herdr), then a profile
   * id. No suffix — and the literal `local` — mean this host.
   */
  async resolve(server?: string): Promise<ResolveServerResult> {
    if (server === undefined || server === LOCAL_SERVER_ID) {
      return { ok: true, server: { id: LOCAL_SERVER_ID, label: LOCAL_SERVER_ID, isLocal: true } };
    }
    const machines = await this.#machines();
    const match = machines.find((machine) => machine.label === server) ?? machines.find((machine) => machine.id === server);
    if (match) return { ok: true, server: { id: match.id, label: match.label, isLocal: false } };
    const known = [LOCAL_SERVER_ID, ...machines.map((machine) => machine.label)].join(", ");
    const why = this.#catalogError
      ? ` I could not read the machine list: ${this.#catalogError}.`
      : !this.remoteEnabled
        ? " Remote machines are disabled in the plugin config."
        : "";
    return { ok: false, message: `I know no Herdr server called "${server}". Known: ${known}.${why}` };
  }

  /** Synchronous, cheap and never throws: display only. */
  describe(serverId: string): ServerDescription {
    if (serverId === LOCAL_SERVER_ID) return { id: LOCAL_SERVER_ID, label: LOCAL_SERVER_ID, isLocal: true };
    const machine = this.#machinesById.get(serverId);
    return { id: serverId, label: machine?.label ?? serverId, isLocal: false };
  }

  /** The `@server` suffix for a target ref, or undefined for the local host. */
  suffix(serverId: string): string | undefined {
    if (serverId === LOCAL_SERVER_ID) return undefined;
    return this.describe(serverId).label;
  }

  /**
   * Whether prompts (and, later, key presses) may be sent to this server.
   * Local always; a machine only when its label or its id is listed in
   * `remote.allowSend`.
   */
  allowsSend(serverId: string): boolean {
    if (serverId === LOCAL_SERVER_ID) return true;
    const allowed = this.#options.allowSend ?? [];
    if (allowed.length === 0) return false;
    const described = this.describe(serverId);
    return allowed.includes(described.id) || allowed.includes(described.label);
  }

  /**
   * The client for one server, building it on first use. For a machine that
   * means one `ssh <target> herdr status server` to learn the remote socket
   * path, then a client whose connections are ssh children.
   */
  async client(serverId: string): Promise<HerdrClient> {
    const existing = this.#clients.get(serverId);
    if (existing) return existing.promise;
    const entry: ClientEntry = { promise: this.#buildClient(serverId) };
    this.#clients.set(serverId, entry);
    try {
      const client = await entry.promise;
      entry.client = client;
      return client;
    } catch (error) {
      // A failed build must not be cached: the machine may come back.
      if (this.#clients.get(serverId) === entry) this.#clients.delete(serverId);
      throw error;
    }
  }

  /**
   * The cached client, or undefined when it is not built yet. Resolution is
   * kicked off in the background, so a caller that cannot await (the watcher)
   * can treat undefined as "not reachable yet" and retry with its own backoff.
   */
  clientFor(serverId: string): HerdrClient | undefined {
    const entry = this.#clients.get(serverId);
    if (entry?.client) return entry.client;
    if (!entry) {
      void this.client(serverId).catch((error: unknown) => {
        this.#logger.warn?.(`herdr: ${this.describe(serverId).label} is not reachable: ${message(error)}`);
      });
    }
    return undefined;
  }

  /** Last known health, without probing. */
  health(serverId: string): ServerHealth | undefined {
    return this.#health.get(serverId)?.health;
  }

  /**
   * Probes one server. Cached for `healthTtlMs`, so listing twice in a row
   * does not pay for two ssh round trips.
   */
  async ping(serverId: string, options: { refresh?: boolean } = {}): Promise<ServerHealth> {
    const cached = this.#health.get(serverId);
    if (!options.refresh && cached && this.#now() - cached.at < (this.#options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS)) {
      return cached.health;
    }
    try {
      const client = await this.client(serverId);
      await client.request("ping", {}, { requestTimeoutMs: this.#options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS });
      return this.#setHealth(serverId, { ok: true });
    } catch (error) {
      this.#dropClient(serverId);
      return this.#setHealth(serverId, { ok: false, reason: shortReason(message(error)) });
    }
  }

  /**
   * Called when something else noticed the server failing (a subscription that
   * died, a request that timed out). Marks it down and drops the client, so the
   * next attempt re-resolves the socket path: a Herdr that restarted elsewhere
   * is exactly this case. It then probes once, in the background, so the next
   * `/herdr list` shows what is true rather than what failed a minute ago —
   * one probe at a time, whatever a flapping machine does.
   */
  reportFailure(serverId: string, reason: string): void {
    if (serverId === LOCAL_SERVER_ID) return;
    this.#setHealth(serverId, { ok: false, reason: shortReason(reason) });
    this.#dropClient(serverId);
    if (this.#probing.has(serverId)) return;
    this.#probing.add(serverId);
    void this.ping(serverId, { refresh: true })
      .catch(() => undefined)
      .finally(() => this.#probing.delete(serverId));
  }

  /** Why the machine list is missing, when it is. */
  catalogError(): string | undefined {
    return this.#catalogError;
  }

  // ---- internals ----

  async #machines(options: { refresh?: boolean } = {}): Promise<Machine[]> {
    const catalog = this.#catalog;
    if (!catalog) {
      this.#machinesById = new Map();
      return [];
    }
    try {
      const machines = await catalog.machines(options.refresh ? { refresh: true } : {});
      this.#machinesById = new Map(machines.map((machine) => [machine.id, machine]));
      this.#catalogError = undefined;
      return machines;
    } catch (error) {
      this.#catalogError = shortReason(message(error));
      this.#logger.warn?.(`herdr: could not list Herdr machines: ${message(error)}`);
      // Keep whatever we knew: a transient `herdr` failure must not make every
      // live remote watch unaddressable.
      return [...this.#machinesById.values()];
    }
  }

  async #buildClient(serverId: string): Promise<HerdrClient> {
    if (serverId === LOCAL_SERVER_ID) throw new HerdrTransportError("the local Herdr client is always available");
    let machine = this.#machinesById.get(serverId);
    if (!machine) {
      await this.#machines();
      machine = this.#machinesById.get(serverId);
    }
    if (!machine) {
      throw new HerdrTransportError(`Herdr does not know a machine with id ${serverId} any more`);
    }
    const controlPath = this.#controlPathFor(machine);
    const socketPath = await resolveRemoteSocketPath({
      target: machine.target,
      ...(machine.session !== undefined ? { session: machine.session } : {}),
      ...(this.#options.sshBin !== undefined ? { sshBin: this.#options.sshBin } : {}),
      ...(controlPath !== undefined ? { controlPath } : {}),
    });
    this.#logger.info?.(`herdr: ${machine.label} (${machine.target}) socket is ${socketPath}`);
    return new HerdrClient({
      socketPath,
      connect: createSshConnectionFactory({
        target: machine.target,
        socketPath,
        ...(this.#options.sshBin !== undefined ? { sshBin: this.#options.sshBin } : {}),
        ...(controlPath !== undefined ? { controlPath } : {}),
      }),
      requestTimeoutMs: this.#options.remoteRequestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
      subscribeAckTimeoutMs:
        this.#options.remoteSubscribeAckTimeoutMs ?? DEFAULT_REMOTE_SUBSCRIBE_ACK_TIMEOUT_MS,
    });
  }

  #controlDir(): string | undefined {
    const stateDir = this.#options.stateDir;
    return stateDir ? path.join(stateDir, "ssh") : undefined;
  }

  #controlPathFor(machine: Machine): string | undefined {
    const dir = this.#controlDir();
    return dir ? path.join(dir, `${machine.id}.sock`) : undefined;
  }

  #dropClient(serverId: string): void {
    if (serverId === LOCAL_SERVER_ID) return;
    this.#clients.delete(serverId);
  }

  #setHealth(serverId: string, health: ServerHealth): ServerHealth {
    this.#health.set(serverId, { health, at: this.#now() });
    return health;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/**
 * The last segment of a layered transport message, which is the part an
 * operator can act on: `Herdr socket error for ping: ssh to alice@buildbox:
 * ssh authentication failed` → `ssh authentication failed`.
 */
export function shortReason(text: string, max = 80): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const segments = flat.split(": ");
  const last = (segments.at(-1) ?? flat).trim() || flat;
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
