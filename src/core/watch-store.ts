import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentStatus } from "../herdr/types.js";

/**
 * Status a watch can settle on. `blocked` is the only non-terminal one: the
 * agent stopped to ask something and the same task continues afterwards.
 * `occupant_changed` means the pane now runs a different terminal than the one
 * we started watching, so nothing observed there can be attributed to us.
 */
export type SettledStatus =
  | Extract<AgentStatus, "idle" | "done" | "blocked">
  | "exited"
  | "occupant_changed"
  | "timed_out";

const SETTLED_STATUSES: readonly string[] = [
  "idle",
  "done",
  "blocked",
  "exited",
  "occupant_changed",
  "timed_out",
];

export function isSettledStatus(value: unknown): value is SettledStatus {
  return typeof value === "string" && SETTLED_STATUSES.includes(value);
}

/** Terminal statuses end the watch; `blocked` keeps it alive. */
export function isTerminalSettledStatus(status: SettledStatus): boolean {
  return status !== "blocked";
}

/**
 * A notification that was produced but not delivered yet. It is persisted
 * apart from the observation so a failing notifier cannot make us forget that
 * the agent finished: the sweep and the next event retry it with backoff, and
 * the watch is only dropped once `notify()` resolves.
 */
export interface PendingDelivery {
  status: SettledStatus;
  text: string;
  /** Failed attempts so far. 0 means "queued, never tried". */
  attempts: number;
  /** ISO date; the sweep skips the delivery until this moment. */
  nextAttemptAt: string;
}

export interface WatchRecord {
  id: string;
  paneId: string;
  /** Herdr terminal that occupied the pane when the watch started. */
  terminalId: string;
  agentLabel: string;
  /** OpenClaw session that asked; notifications go back there. */
  sessionKey: string;
  agentId?: string;
  promptPreview: string;
  createdAt: string;
  deadlineAt: string;
  /**
   * Herdr `state_change_seq` observed when the watch started. Optional on
   * purpose: older Herdr builds may omit it, and without it we never infer
   * completion from sequence movement.
   */
  seqAtStart?: number;
  /** Most recent `state_change_seq` seen from `agent.get`. */
  lastSeq?: number;
  /** Last status Herdr reported. `unknown` is uncertainty, never evidence. */
  lastStatus?: string;
  /**
   * Evidence that the watched task actually ran: set when Herdr reported
   * `working` or `blocked` since the watch started, or when `state_change_seq`
   * advanced past `seqAtStart`. Kept apart from `lastStatus` so a transient
   * `unknown` between `working` and `idle` cannot erase the completion.
   */
  sawWorking: boolean;
  /**
   * Incremented on every settle, so repeated `blocked` events on the same
   * watch get distinct identities. The notifier uses (`id`, `notificationSeq`)
   * as its idempotency key: retries of the same delivery keep the same number.
   */
  notificationSeq: number;
  /**
   * Terminal status this watch already settled on. Set before the delivery is
   * attempted, so a second terminal event (the classic `done` + `pane.exited`
   * race) cannot produce a second notification.
   */
  settledStatus?: SettledStatus;
  pendingDelivery?: PendingDelivery;
}

/** What `add()` needs; the bookkeeping fields are filled in here. */
export type WatchInput = Omit<
  WatchRecord,
  "id" | "createdAt" | "notificationSeq" | "settledStatus" | "pendingDelivery" | "sawWorking"
> & { sawWorking?: boolean };

/** `pendingDelivery: null` clears the slot (`undefined` cannot, under exactOptionalPropertyTypes). */
export type WatchPatch = Partial<Omit<WatchRecord, "id" | "createdAt" | "pendingDelivery">> & {
  pendingDelivery?: PendingDelivery | null;
};

interface StoreFile {
  version: 1;
  watches: WatchRecord[];
}

export interface StoreLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Durable list of active watches. One small JSON file, rewritten atomically.
 * It only holds routing state; Herdr remains the source of truth for what the
 * agent is doing.
 *
 * Keying policy (finding 10): at most one watch per (paneId, sessionKey). Two
 * chats may watch the same pane at the same time and both get notified; a new
 * watch from the same session replaces that session's previous one.
 */
export class WatchStore {
  #file: string;
  #watches: WatchRecord[] = [];
  #loaded = false;
  #writes: Promise<void> = Promise.resolve();
  #tmpCounter = 0;
  #logger: StoreLogger;

  constructor(stateDir: string, logger: StoreLogger = {}) {
    this.#file = path.join(stateDir, "watches.json");
    this.#logger = logger;
  }

  get file(): string {
    return this.#file;
  }

  /**
   * Reads the file, dropping anything it cannot trust. A record with a broken
   * shape or an unparseable date is skipped and logged; a file that is not
   * valid JSON (or not the expected object) is moved aside as
   * `watches.json.corrupt-<ts>` and we start empty rather than crash the
   * plugin on boot.
   */
  async load(): Promise<void> {
    this.#watches = [];
    this.#loaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.#file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.#logger.error?.(`herdr watch store ${this.#file} could not be read (${code ?? "error"}); starting empty`);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.#quarantine(`is not valid JSON (${(error as Error).message})`);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.watches)) {
      await this.#quarantine("does not hold a watch list");
      return;
    }

    const kept: WatchRecord[] = [];
    for (const [index, candidate] of (parsed.watches as unknown[]).entries()) {
      const outcome = readRecord(candidate);
      if (outcome.ok) kept.push(outcome.record);
      else this.#logger.warn?.(`herdr watch store: skipping record ${index} (${outcome.reason})`);
    }
    this.#watches = kept;
  }

  list(): WatchRecord[] {
    this.#assertLoaded();
    return [...this.#watches];
  }

  byId(id: string): WatchRecord | undefined {
    this.#assertLoaded();
    return this.#watches.find((watch) => watch.id === id);
  }

  /** First watch on that pane; only meaningful for display, never for scoping. */
  byPane(paneId: string): WatchRecord | undefined {
    this.#assertLoaded();
    return this.#watches.find((watch) => watch.paneId === paneId);
  }

  listByPane(paneId: string): WatchRecord[] {
    this.#assertLoaded();
    return this.#watches.filter((watch) => watch.paneId === paneId);
  }

  byPaneAndSession(paneId: string, sessionKey: string): WatchRecord | undefined {
    this.#assertLoaded();
    return this.#watches.find((watch) => watch.paneId === paneId && watch.sessionKey === sessionKey);
  }

  /**
   * Adds a watch, replacing this session's previous watch on the same pane.
   * The replaced record is returned so the caller can close its subscription
   * as part of the same logical operation (finding 7).
   */
  async add(input: WatchInput): Promise<{ record: WatchRecord; replaced?: WatchRecord }> {
    this.#assertLoaded();
    const replaced = this.#watches.find(
      (watch) => watch.paneId === input.paneId && watch.sessionKey === input.sessionKey,
    );
    if (replaced) this.#watches = this.#watches.filter((watch) => watch.id !== replaced.id);
    const record: WatchRecord = {
      ...input,
      sawWorking: input.sawWorking ?? false,
      notificationSeq: 0,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.#watches.push(record);
    await this.#save();
    return replaced ? { record, replaced } : { record };
  }

  /** Patches an existing record. Returns false when it is already gone. */
  async update(id: string, patch: WatchPatch): Promise<boolean> {
    this.#assertLoaded();
    const current = this.#watches.find((watch) => watch.id === id);
    if (!current) return false;
    const { pendingDelivery, ...rest } = patch;
    const next: WatchRecord = { ...current, ...rest, id: current.id, createdAt: current.createdAt };
    if (pendingDelivery === null) delete next.pendingDelivery;
    else if (pendingDelivery !== undefined) next.pendingDelivery = pendingDelivery;
    this.#watches = this.#watches.map((watch) => (watch.id === id ? next : watch));
    await this.#save();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    this.#assertLoaded();
    const before = this.#watches.length;
    this.#watches = this.#watches.filter((watch) => watch.id !== id);
    if (this.#watches.length === before) return false;
    await this.#save();
    return true;
  }

  /** Writes are serialized so concurrent updates never race on the temp file. */
  #save(): Promise<void> {
    const snapshot: StoreFile = { version: 1, watches: [...this.#watches] };
    this.#tmpCounter += 1;
    const tmp = `${this.#file}.${process.pid}.${this.#tmpCounter}.tmp`;
    const write = async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    };
    this.#writes = this.#writes.then(write, write);
    return this.#writes;
  }

  async #quarantine(reason: string): Promise<void> {
    const target = `${this.#file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.#file, target);
      this.#logger.error?.(`herdr watch store ${reason}; moved to ${target} and starting empty`);
    } catch (error) {
      this.#logger.error?.(
        `herdr watch store ${reason} and could not be moved aside (${(error as Error).message}); starting empty`,
      );
    }
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("WatchStore.load() must run before use");
  }
}

type ReadOutcome = { ok: true; record: WatchRecord } | { ok: false; reason: string };

/**
 * Validates one persisted record. Strict about identity and dates (without
 * them the record is unusable), lenient about everything a former version may
 * not have written yet, so upgrading the plugin does not silently drop live
 * watches.
 */
function readRecord(value: unknown): ReadOutcome {
  if (!isRecord(value)) return { ok: false, reason: "not an object" };
  for (const key of ["id", "paneId", "sessionKey"] as const) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) return { ok: false, reason: `missing ${key}` };
  }
  const createdAt = readDate(value.createdAt);
  if (!createdAt) return { ok: false, reason: "invalid createdAt" };
  const deadlineAt = readDate(value.deadlineAt);
  if (!deadlineAt) return { ok: false, reason: "invalid deadlineAt" };

  const record: WatchRecord = {
    id: value.id as string,
    paneId: value.paneId as string,
    terminalId: typeof value.terminalId === "string" ? value.terminalId : "",
    agentLabel: typeof value.agentLabel === "string" ? value.agentLabel : "agent",
    sessionKey: value.sessionKey as string,
    promptPreview: typeof value.promptPreview === "string" ? value.promptPreview : "",
    createdAt,
    deadlineAt,
    sawWorking: value.sawWorking === true,
    notificationSeq: readCount(value.notificationSeq),
  };
  if (typeof value.agentId === "string" && value.agentId) record.agentId = value.agentId;
  if (isFiniteNumber(value.seqAtStart)) record.seqAtStart = value.seqAtStart;
  if (isFiniteNumber(value.lastSeq)) record.lastSeq = value.lastSeq;
  if (typeof value.lastStatus === "string") record.lastStatus = value.lastStatus;
  if (isSettledStatus(value.settledStatus)) record.settledStatus = value.settledStatus;
  const pending = readPending(value.pendingDelivery);
  if (pending) record.pendingDelivery = pending;
  return { ok: true, record };
}

function readPending(value: unknown): PendingDelivery | undefined {
  if (!isRecord(value)) return undefined;
  if (!isSettledStatus(value.status) || typeof value.text !== "string") return undefined;
  const nextAttemptAt = readDate(value.nextAttemptAt) ?? new Date().toISOString();
  return { status: value.status, text: value.text, attempts: readCount(value.attempts), nextAttemptAt };
}

function readDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function readCount(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? Math.floor(value) : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
